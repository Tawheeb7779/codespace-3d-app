import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_SCRIPTS, availableChecks, runCheck } from '../src/checks.ts';
import { SyncIndex } from '../src/sync.ts';
import { loadConfig } from '../src/config.ts';
import type { ContainerRecord } from '../src/lifecycle.ts';
import type { ContainerRuntime } from '../src/runtime/types.ts';

/**
 * The agent's verification path, and the boundary that keeps it from being a
 * shell.
 *
 * The agent names a script. It never supplies a command line, an argument
 * vector or a flag — the same decision as `git.ts`, and for the same reason.
 * What the container then runs is whatever the project defines for that script,
 * which is deliberate: the container is the sandbox, and the user's own code
 * already runs there. What is bounded is the *shape* of the request.
 */

let root: string;

function record(overrides: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 'tacode-' + 'a'.repeat(32),
    userId: 'user-amina',
    kind: 'project',
    projectId: 'proj-alpha',
    tier: loadConfig({}).tiers.free,
    status: 'ready',
    workspaceDir: root,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    index: new SyncIndex(),
    openPorts: new Set(),
    ...overrides,
  };
}

/** A runtime that records the argv rather than running it. */
function recording(result: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: string[][] = [];
  const runtime = {
    runCommand: async (_id: string, argv: string[]) => {
      calls.push(argv);
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    },
  } as unknown as ContainerRuntime;
  return { calls, runner: { runtime, record: record() } };
}

const manifest = (scripts: Record<string, string>) =>
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts }, null, 2));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tacode-checks-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('which checks a project offers', () => {
  it('reports only the allowed scripts the project actually defines', async () => {
    await manifest({ test: 'vitest run', lint: 'eslint .', dev: 'vite', deploy: './ship.sh' });

    const available = await availableChecks(record());

    expect(available).toEqual(['test', 'lint']);
  });

  /**
   * `deploy`, `publish` and `release` are names projects choose too. The agent
   * is asking "did I break anything", and the allowlist is what keeps that from
   * becoming "run whatever this repository defines".
   */
  it('never offers a script outside the allowlist, however the project names it', async () => {
    await manifest({ deploy: 'x', publish: 'x', release: 'x', start: 'x', 'test:e2e': 'x' });

    expect(await availableChecks(record())).toEqual([]);
  });

  it('is empty for a project with no manifest at all', async () => {
    expect(await availableChecks(record())).toEqual([]);
  });

  it('is empty rather than throwing for a manifest that is not JSON', async () => {
    await writeFile(join(root, 'package.json'), '{ this is not json');

    expect(await availableChecks(record())).toEqual([]);
  });

  it('is empty for a manifest with no scripts block', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'p' }));

    expect(await availableChecks(record())).toEqual([]);
  });

  /**
   * A `package.json` that is a symlink is not this project's manifest. Reading
   * it would let a workspace point at a file outside itself and have the
   * gateway read it.
   */
  it('does not read a manifest that is a symlink out of the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tacode-outside-'));
    try {
      await writeFile(join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
      await symlink(join(outside, 'package.json'), join(root, 'package.json'));

      expect(await availableChecks(record())).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('ignores a manifest too large to be one', async () => {
    await writeFile(join(root, 'package.json'), 'x'.repeat(600 * 1024));

    expect(await availableChecks(record())).toEqual([]);
  });
});

describe('running a check', () => {
  it('runs npm with the script name as its own argument', async () => {
    await manifest({ test: 'vitest run' });
    const { calls, runner } = recording({ stdout: 'all good\n' });

    await runCheck(runner, 'test');

    const argv = calls.at(-1)!;
    expect(argv).toContain('npm');
    expect(argv).toContain('run');
    expect(argv).toContain('test');
    // An argument vector, so nothing is parsed by a shell.
    expect(argv.join(' ')).not.toMatch(/&&|\||;|\$\(/);
  });

  /**
   * A failing check is a *result*. The agent has to read the output to fix
   * what it broke, so a non-zero exit must not arrive as an exception.
   */
  it('returns a failing check as a readable result rather than throwing', async () => {
    await manifest({ test: 'vitest run' });
    const { runner } = recording({ stdout: '2 failed\n', code: 1 });

    const result = await runCheck(runner, 'test');

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 failed');
  });

  it.each(['deploy', 'publish', 'start', 'preinstall', 'test:e2e', 'TEST', '../x', 'test;rm'])(
    'refuses the script %j',
    async (script) => {
      await manifest({ [script]: 'x', test: 'x' });
      const { runner } = recording();

      await expect(runCheck(runner, script)).rejects.toThrow(/not a check|does not define/i);
    },
  );

  it('refuses an allowed name the project does not define', async () => {
    await manifest({ test: 'vitest run' });
    const { runner } = recording();

    await expect(runCheck(runner, 'lint')).rejects.toThrow(/does not define/i);
  });

  /**
   * A check that prints a hundred megabytes must not become a hundred-megabyte
   * frame. Both ends are kept because a test run's failure is usually early and
   * its summary is at the end.
   */
  it('truncates enormous output from both ends and says so', async () => {
    await manifest({ test: 'x' });
    const { runner } = recording({ stdout: `START${'x'.repeat(200_000)}END` });

    const result = await runCheck(runner, 'test');

    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(200_000);
    expect(result.output).toContain('START');
    expect(result.output).toContain('END');
    expect(result.output).toContain('truncated');
  });

  it('bounds every run with a timeout', async () => {
    await manifest({ test: 'x' });
    let options: { timeoutMs?: number } | undefined;
    const runtime = {
      runCommand: async (_id: string, _argv: string[], opts: { timeoutMs?: number }) => {
        options = opts;
        return { stdout: '', stderr: '', code: 0 };
      },
    } as unknown as ContainerRuntime;

    await runCheck({ runtime, record: record() }, 'test');

    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  it('runs with CI set, so a watch-mode default does not hang forever', async () => {
    await manifest({ test: 'vitest' });
    const { calls, runner } = recording();

    await runCheck(runner, 'test');

    expect(calls.at(-1)!.join(' ')).toContain('CI=1');
  });

  it('offers exactly five checks and no way to add a sixth at runtime', () => {
    expect([...CHECK_SCRIPTS].sort()).toEqual(['build', 'lint', 'test', 'typecheck', 'verify']);
  });
});
