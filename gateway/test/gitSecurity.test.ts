import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncIndex } from '../src/sync.ts';
import { loadConfig } from '../src/config.ts';
import { transferFiles } from '../src/transfer.ts';
import { containerIdFor } from '../src/lifecycle.ts';
import type { ContainerRecord } from '../src/lifecycle.ts';
import type { ContainerRuntime } from '../src/runtime/types.ts';
import * as git from '../src/git.ts';

/**
 * The attacks Phase 2's new surfaces invite, tried rather than assumed.
 *
 * Two surfaces are new and both accept caller input: git, which is a program
 * whose options can read files, run commands and open sockets; and transfer,
 * which is the only path between two workspaces that are otherwise unconnected.
 *
 * These run without a daemon, because what is under test is the argument
 * vector and the path resolution rather than the container. The real-container
 * half is `gitDocker.test.ts`, and the two are complementary: this one can
 * assert what git was *asked* to do, which is invisible once it has run.
 */

const tier = loadConfig({}).tiers.free;

function workspaceRecord(overrides: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 'tacode-' + 'a'.repeat(32),
    userId: 'user-amina',
    kind: 'project',
    projectId: 'proj-alpha',
    tier,
    status: 'ready',
    workspaceDir: '/tmp/nowhere',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    index: new SyncIndex(),
    openPorts: new Set(),
    ...overrides,
  };
}

/** A runtime that records the argument vector instead of running it. */
function recordingRuntime(stdout = '') {
  const calls: string[][] = [];
  const runtime = {
    runCommand: async (_id: string, argv: string[]) => {
      calls.push(argv);
      return { stdout, stderr: '', code: 0 };
    },
  } as unknown as ContainerRuntime;
  return { calls, runner: { runtime, record: workspaceRecord() } };
}

describe('what git is actually asked to run', () => {
  /**
   * The property the typed-operation design exists for: no caller input becomes
   * a git option. Asserted on the argv rather than on the outcome, because an
   * injected flag that happens to fail still proves the injection was possible.
   */
  it('never lets a path become an option, because writes pass `--` first', async () => {
    const { calls, runner } = recordingRuntime('true');
    await git.add(runner, ['src/app.ts']);

    const argv = calls.at(-1)!;
    const dashDash = argv.indexOf('--');
    const path = argv.indexOf('src/app.ts');
    expect(dashDash).toBeGreaterThan(-1);
    expect(path).toBeGreaterThan(dashDash);
  });

  /**
   * Git reads configuration from three places and runs programs from two of
   * them. The environment below closes each, and it is asserted rather than
   * trusted because a future edit that drops one is invisible.
   */
  it('runs git with credential prompts, system config and pagers disabled', async () => {
    const { calls, runner } = recordingRuntime('true');
    await git.status(runner);

    const argv = calls.at(-1)!.join(' ');
    expect(argv).toContain('GIT_TERMINAL_PROMPT=0');
    expect(argv).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(argv).toContain('GIT_ASKPASS=');
    expect(argv).toContain('GIT_PAGER=cat');
  });

  it('never passes a working directory or git directory the caller chose', async () => {
    const { calls, runner } = recordingRuntime('true');
    await git.status(runner);
    await git.log(runner, 5);

    for (const argv of calls) {
      const joined = argv.join(' ');
      expect(joined).not.toMatch(/--git-dir/);
      expect(joined).not.toMatch(/--work-tree/);
      expect(joined).not.toMatch(/(^| )-C( |$)/);
    }
  });

  /**
   * Every spelling of "run a program through git" that a caller might reach
   * for, tried in the fields where a caller supplies a string.
   */
  it.each([
    '--upload-pack=/bin/sh',
    '--receive-pack=/bin/sh',
    '-c core.sshCommand=/bin/sh',
    '-c core.pager=/bin/sh',
    '-c alias.x=!sh',
    '--exec-path=/tmp',
    '--git-dir=/etc',
    '-C /',
    '--namespace=x',
  ])('refuses %s as a revision', async (hostile) => {
    const { runner } = recordingRuntime();

    await expect(git.revParse(runner, hostile)).rejects.toThrow(/not a valid revision/i);
    await expect(git.createBranch(runner, hostile)).rejects.toThrow(/not a valid/i);
    await expect(git.checkout(runner, hostile, { confirm: true })).rejects.toThrow(/not a valid/i);
  });

  it.each(['../../etc/passwd', '..\\..\\windows', 'a\u0000b', ''])(
    'refuses %j as a path',
    async (hostile) => {
      const { runner } = recordingRuntime();

      await expect(git.add(runner, [hostile])).rejects.toThrow();
    },
  );

  /**
   * An absolute path is clamped to workspace-relative rather than refused, and
   * that is the deliberate contract `normalizePath` has had since Phase 1:
   * `/etc/passwd` becomes `etc/passwd`, a file inside the workspace. Asserted
   * on the argv so it is unambiguous that git is never handed the absolute one.
   */
  it('clamps an absolute path into the workspace instead of escaping', async () => {
    const { calls, runner } = recordingRuntime('true');

    await git.add(runner, ['/etc/passwd']);

    const argv = calls.at(-1)!;
    expect(argv).toContain('etc/passwd');
    expect(argv).not.toContain('/etc/passwd');
  });

  /**
   * A URL is not a revision. This is the shape a caller would use to try to
   * turn git into an outbound request, and it never reaches an argv.
   */
  it.each(['https://attacker.example/repo', 'git@github.com:a/b', 'ssh://x/y', 'file:///etc'])(
    'refuses the remote-looking ref %s',
    async (hostile) => {
      const { runner } = recordingRuntime();

      await expect(git.revParse(runner, hostile)).rejects.toThrow(/not a valid revision/i);
    },
  );

  /**
   * The absence that matters most. No exported operation reaches the network,
   * so there is no fetch, pull, push or clone to authorise, rate-limit or
   * allowlist — and no way to use git as a tunnel.
   */
  it('exposes no operation that reaches the network', () => {
    const exported = Object.keys(git);

    for (const networked of ['fetch', 'pull', 'push', 'clone', 'addRemote', 'lsRemote']) {
      expect(exported).not.toContain(networked);
    }
  });

  it('bounds every invocation with a timeout and an output cap', async () => {
    let options: unknown;
    const runtime = {
      runCommand: async (_id: string, _argv: string[], opts: unknown) => {
        options = opts;
        return { stdout: 'true', stderr: '', code: 0 };
      },
    } as unknown as ContainerRuntime;

    await git.status({ runtime, record: workspaceRecord() });

    expect(options).toMatchObject({ timeoutMs: expect.any(Number), maxBuffer: expect.any(Number) });
  });
});

describe('what a commit records', () => {
  /**
   * The author is the authenticated identity, passed per invocation. Two
   * properties: a commit cannot be attributed to somebody else, and the
   * identity is never written into a config file inside the workspace — where
   * the user's own code could read it.
   */
  it('takes the author from the caller and writes no config into the workspace', async () => {
    const { calls, runner } = recordingRuntime('abc123');

    await git.commit(runner, 'A change', { name: 'Amina', email: 'amina@example.test' });

    const argv = calls[0].join(' ');
    expect(argv).toContain('GIT_AUTHOR_EMAIL=amina@example.test');
    expect(argv).toContain('GIT_COMMITTER_EMAIL=amina@example.test');
    // No `git config` anywhere: identity is environment, not state on disk.
    for (const call of calls) expect(call.join(' ')).not.toMatch(/git config/);
  });

  it('refuses an empty commit message rather than inventing one', async () => {
    const { runner } = recordingRuntime();

    await expect(git.commit(runner, '   ', { name: 'A', email: 'a@b' })).rejects.toThrow(
      /needs a message/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

async function twoWorkspaces() {
  const root = await mkdtemp(join(tmpdir(), 'tacode-xfer-'));
  const projectDir = join(root, 'project');
  const linuxDir = join(root, 'linux');
  const outside = join(root, 'outside');
  await mkdir(projectDir, { recursive: true });
  await mkdir(linuxDir, { recursive: true });
  await mkdir(outside, { recursive: true });

  const project = workspaceRecord({ id: 'tacode-p', workspaceDir: projectDir });
  const linux = workspaceRecord({
    id: 'tacode-l',
    kind: 'linux',
    projectId: null,
    workspaceDir: linuxDir,
  });
  return { root, projectDir, linuxDir, outside, project, linux };
}

describe('the only path between two workspaces', () => {
  it('refuses a transfer between two different people’s workspaces', async () => {
    const { root, project, linux } = await twoWorkspaces();
    try {
      const theirs = { ...linux, userId: 'user-bilal' };

      await expect(transferFiles(project, theirs, ['anything.ts'])).rejects.toThrow(
        /different people/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a workspace copying to itself', async () => {
    const { root, project } = await twoWorkspaces();
    try {
      await expect(transferFiles(project, project, ['a.ts'])).rejects.toThrow(/itself/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A workspace owns its own tree and can plant a link in it. Following one
   * during a transfer would read a host file and write it into the other
   * workspace, as the gateway's user.
   */
  it('does not follow a symlink out of the source', async () => {
    const { root, projectDir, outside, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(outside, 'host-secret.txt'), 'HOST SECRET\n');
      await symlink(outside, join(projectDir, 'escape'));

      const outcome = await transferFiles(project, linux, ['escape/host-secret.txt']);

      expect(outcome.copied).toEqual([]);
      expect(outcome.skipped).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** And not into a link at the destination, which is the write direction. */
  it('does not follow a symlink out of the destination', async () => {
    const { root, projectDir, linuxDir, outside, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'payload.txt'), 'written by a transfer\n');
      await symlink(outside, join(linuxDir, 'escape'));

      const outcome = await transferFiles(project, linux, ['escape/payload.txt']);

      expect(outcome.copied).toEqual([]);
      await expect(readFile(join(outside, 'payload.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['.env', '.env.local', '.ssh/id_rsa', '.npmrc', '.aws/credentials', '.git/config'])(
    'never carries %s',
    async (path) => {
      const { root, projectDir, project, linux } = await twoWorkspaces();
      try {
        await mkdir(join(projectDir, path.split('/').slice(0, -1).join('/') || '.'), {
          recursive: true,
        });
        await writeFile(join(projectDir, path), 'SECRET=leaked\n');

        const outcome = await transferFiles(project, linux, [path]);

        expect(outcome.copied).toEqual([]);
        expect(outcome.skipped[0].reason).toBe('protected path');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('reports a conflict rather than overwriting, and overwrites only when asked', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'both.ts'), 'from the project\n');
      await writeFile(join(linuxDir, 'both.ts'), 'from linux\n');

      const refused = await transferFiles(project, linux, ['both.ts']);
      expect(refused.conflicts).toEqual(['both.ts']);
      expect(await readFile(join(linuxDir, 'both.ts'), 'utf8')).toBe('from linux\n');

      const forced = await transferFiles(project, linux, ['both.ts'], { overwrite: true });
      expect(forced.copied).toEqual(['both.ts']);
      expect(await readFile(join(linuxDir, 'both.ts'), 'utf8')).toBe('from the project\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a file larger than the transfer limit', async () => {
    const { root, projectDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'huge.bin'), Buffer.alloc(9 * 1024 * 1024));

      const outcome = await transferFiles(project, linux, ['huge.bin']);

      expect(outcome.copied).toEqual([]);
      expect(outcome.skipped[0].reason).toMatch(/size limit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds the total size of one transfer, not only each file', async () => {
    const { root, projectDir, project, linux } = await twoWorkspaces();
    try {
      const paths: string[] = [];
      // Ten files of 7MB: each under the per-file cap, together over the total.
      for (let i = 0; i < 10; i++) {
        const path = `big-${i}.bin`;
        await writeFile(join(projectDir, path), Buffer.alloc(7 * 1024 * 1024));
        paths.push(path);
      }

      const outcome = await transferFiles(project, linux, paths);

      expect(outcome.copied.length).toBeLessThan(paths.length);
      expect(outcome.skipped.some((entry) => /total size/.test(entry.reason))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies a directory’s file without copying the directory itself', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await mkdir(join(projectDir, 'src'), { recursive: true });
      await writeFile(join(projectDir, 'src', 'app.ts'), 'export const x = 1;\n');

      const outcome = await transferFiles(project, linux, ['src', 'src/app.ts']);

      expect(outcome.copied).toEqual(['src/app.ts']);
      expect(outcome.skipped.some((entry) => entry.reason === 'not a file')).toBe(true);
      expect(await readFile(join(linuxDir, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('workspace identity across the two kinds', () => {
  it('gives a person’s Linux workspace a different id from every project of theirs', () => {
    const linux = containerIdFor('user-amina', null, 'linux');

    for (const project of ['linux', '', 'proj-alpha', 'null', 'undefined']) {
      expect(containerIdFor('user-amina', project, 'project')).not.toBe(linux);
    }
  });

  it('gives two people different Linux workspaces', () => {
    expect(containerIdFor('user-amina', null, 'linux')).not.toBe(
      containerIdFor('user-bilal', null, 'linux'),
    );
  });

  it('keeps a Linux workspace stable, so reconnecting finds the same one', () => {
    expect(containerIdFor('user-amina', null, 'linux')).toBe(
      containerIdFor('user-amina', null, 'linux'),
    );
  });
});
