import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createDockerRuntime } from '../src/runtime/docker.ts';
import { loadConfig } from '../src/config.ts';
import { SyncIndex } from '../src/sync.ts';
import type { ContainerRecord } from '../src/lifecycle.ts';
import * as git from '../src/git.ts';

const run = promisify(execFile);

/**
 * Real Git, in a real container, against a real repository.
 *
 * Nothing here is mocked, and that is the entire point of the file: a git
 * service tested against a fake of git proves that the fake agrees with the
 * code, which is not a fact anybody needs. These tests run `git` — the program
 * — inside a container with `--cap-drop ALL`, a read-only root, no network and
 * uid 10001, which is where it will actually run.
 *
 *   TACODE_DOCKER_TESTS=1 npx vitest run test/gitDocker.test.ts
 *
 * Skipped loudly without a daemon, for the same reason the isolation suite is:
 * a security-relevant suite that passes vacuously is worse than one that is
 * absent, because somebody reads the tick.
 */

const ENABLED = process.env.TACODE_DOCKER_TESTS === '1';
const IMAGE = process.env.TACODE_TEST_IMAGE ?? 'ta-code/workspace-test:1';
const NAME = 'tacode-git-probe';
const WORKSPACE = '/var/lib/ta-code-test/git';

const runtime = createDockerRuntime({ diskQuota: false });
const tier = { ...loadConfig({}).tiers.free, pids: 128, memoryMb: 256 };

const record: ContainerRecord = {
  id: NAME,
  userId: 'user-amina',
  kind: 'project',
  projectId: 'proj-alpha',
  tier,
  status: 'ready',
  workspaceDir: WORKSPACE,
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  index: new SyncIndex(),
  openPorts: new Set(),
};

const runner = { runtime, record };
const author = { name: 'Amina Diallo', email: 'amina@example.test' };

/** Write a file into the workspace the way the editor's sync would. */
const put = (path: string, content: string) => writeFile(`${WORKSPACE}/${path}`, content);

beforeAll(async () => {
  if (!ENABLED) return;
  await run('docker', ['version'], { timeout: 15_000 });
  await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(WORKSPACE, { recursive: true });

  await runtime.create({
    containerId: NAME,
    workspaceDir: WORKSPACE,
    tier,
    image: IMAGE,
    network: 'none',
  });
  await runtime.start(NAME);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
});

const test = ENABLED ? it : it.skip;

describe.skipIf(!ENABLED)('git, actually running in the workspace', () => {
  test('git01 — the workspace starts without a repository, and says so', async () => {
    const state = await git.status(runner);

    expect(state.repository).toBe(false);
    expect(state.dirty).toBe(false);
  });

  test('git02 — init creates a real repository on disk', async () => {
    const created = await git.init(runner);

    expect(created).toEqual({ created: true });
    expect(await git.isRepository(runner)).toBe(true);
  });

  /**
   * A project may already contain `.git` — imported from GitHub, restored, or
   * created in the terminal. Re-initialising is not destructive but it is not
   * nothing either, so the two cases stay distinguishable.
   */
  test('git03 — init over an existing repository does not touch it', async () => {
    const again = await git.init(runner);

    expect(again).toEqual({ created: false });
  });

  test('git04 — sees a file the editor wrote as untracked', async () => {
    await put('app.ts', 'export const answer = 42;\n');

    const state = await git.status(runner);

    const entry = state.files.find((file) => file.path === 'app.ts');
    expect(entry?.untracked).toBe(true);
    expect(state.dirty).toBe(true);
  });

  test('git05 — stages, commits, and the commit is readable back', async () => {
    await git.add(runner, ['app.ts']);
    const staged = await git.status(runner);
    expect(staged.files.find((file) => file.path === 'app.ts')?.staged).toBe(true);

    const commit = await git.commit(runner, 'Add the answer', author);
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);

    const history = await git.log(runner, 10);
    expect(history[0].subject).toBe('Add the answer');
    // The author is the authenticated identity, which is what makes the record
    // worth anything.
    expect(history[0].email).toBe('amina@example.test');

    const clean = await git.status(runner);
    expect(clean.dirty).toBe(false);
    expect(clean.branch).toBe('main');
  });

  test('git06 — an edit after the commit shows as modified, not untracked', async () => {
    await put('app.ts', 'export const answer = 43;\n');

    const state = await git.status(runner);

    const entry = state.files.find((file) => file.path === 'app.ts');
    expect(entry?.untracked).toBe(false);
    expect(entry?.unstaged).toBe(true);
  });

  test('git07 — diff is a real diff of the real file', async () => {
    const patch = await git.diff(runner);

    expect(patch).toContain('-export const answer = 42;');
    expect(patch).toContain('+export const answer = 43;');
  });

  test('git08 — unstage puts a staged file back without touching the worktree', async () => {
    await git.add(runner, ['app.ts']);
    expect((await git.status(runner)).files[0].staged).toBe(true);

    await git.unstage(runner, ['app.ts']);

    const state = await git.status(runner);
    expect(state.files[0].staged).toBe(false);
    expect(state.files[0].unstaged).toBe(true);
  });

  test('git09 — branches are created and listed', async () => {
    await git.createBranch(runner, 'feature/real-git');

    const listed = await git.branches(runner);
    expect(listed.all).toContain('feature/real-git');
    expect(listed.current).toBe('main');
  });

  test('git10 — rev-parse and show read real objects', async () => {
    const head = await git.revParse(runner, 'HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    const shown = await git.show(runner, 'HEAD');
    expect(shown).toContain('Add the answer');
  });
});

// ---------------------------------------------------------------------------
// Destructive operations
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('git operations that could lose work', () => {
  /**
   * The property the whole safety design exists for. The worktree is dirty —
   * `app.ts` was modified above and never committed — so switching branch is
   * refused rather than performed, and the refusal names what is at risk.
   */
  test('git11 — refuses to switch branch while changes are uncommitted', async () => {
    const before = await git.status(runner);
    expect(before.dirty).toBe(true);

    await expect(git.checkout(runner, 'feature/real-git')).rejects.toThrow(
      /would discard uncommitted changes/i,
    );

    // Still on the same branch, and the change is still there.
    const after = await git.status(runner);
    expect(after.branch).toBe('main');
    expect(after.dirty).toBe(true);
  });

  test('git12 — names the files that would be lost, not merely that some would', async () => {
    const plan = await git.destructivePlan(runner);

    expect(plan.wouldLose).toBe(true);
    expect(plan.paths).toContain('app.ts');
  });

  test('git13 — switches once the caller confirms', async () => {
    await git.checkout(runner, 'feature/real-git', { confirm: true });

    expect((await git.status(runner)).branch).toBe('feature/real-git');
  });

  test('git14 — refuses to discard without confirmation', async () => {
    await expect(git.discard(runner, ['app.ts'])).rejects.toThrow(/cannot be undone/i);

    // The modification survives the refusal.
    expect((await git.status(runner)).dirty).toBe(true);
  });

  test('git15 — discards when confirmed, and the file returns to its committed state', async () => {
    await git.discard(runner, ['app.ts'], { confirm: true });

    const state = await git.status(runner);
    expect(state.dirty).toBe(false);
    const shown = await git.show(runner, 'HEAD');
    expect(shown).toContain('answer = 42');
  });

  test('git16 — refuses to delete a branch without confirmation, and refuses the current one', async () => {
    await expect(git.deleteBranch(runner, 'main')).rejects.toThrow(/cannot be undone/i);
    await expect(
      git.deleteBranch(runner, 'feature/real-git', { confirm: true }),
    ).rejects.toThrow(/branch you are on/i);
  });

  test('git17 — deletes a merged branch when confirmed', async () => {
    await git.checkout(runner, 'main', { confirm: true });
    await git.createBranch(runner, 'throwaway');

    await git.deleteBranch(runner, 'throwaway', { confirm: true });

    expect((await git.branches(runner)).all).not.toContain('throwaway');
  });

  /**
   * `-d` and never `-D`. Git's own refusal to delete unmerged work is the
   * safety property; offering the force flag would remove it for the
   * convenience of not reading the error.
   */
  test('git18 — will not force-delete a branch with unmerged commits', async () => {
    await git.createBranch(runner, 'unmerged');
    await git.checkout(runner, 'unmerged', { confirm: true });
    await put('only-here.ts', 'export const x = 1;\n');
    await git.add(runner, ['only-here.ts']);
    await git.commit(runner, 'Work only on this branch', author);
    await git.checkout(runner, 'main', { confirm: true });

    await expect(git.deleteBranch(runner, 'unmerged', { confirm: true })).rejects.toThrow();
    expect((await git.branches(runner)).all).toContain('unmerged');
  });
});

// ---------------------------------------------------------------------------
// The attacks the typed-operation design exists to prevent
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('git as an attack surface', () => {
  /**
   * Git's options are the dangerous part, not its subcommands. None of these
   * can be expressed through the typed API, and each is tried in the field
   * where a caller does control a string.
   */
  test('git19 — a ref that is really an option is refused', async () => {
    for (const hostile of [
      '--upload-pack=/bin/sh',
      '-c core.sshCommand=/bin/sh',
      '--git-dir=/etc',
      '--work-tree=/',
    ]) {
      await expect(git.checkout(runner, hostile, { confirm: true })).rejects.toThrow(
        /not a valid revision/i,
      );
    }
  });

  test('git20 — a ref containing a path traversal or a range is refused', async () => {
    for (const hostile of ['../../etc/passwd', 'main..other', 'main:file', '../.git']) {
      await expect(git.revParse(runner, hostile)).rejects.toThrow(/not a valid revision/i);
    }
  });

  test('git21 — a path that escapes the workspace is refused before git sees it', async () => {
    for (const hostile of ['../outside.txt', '/etc/passwd', '../../root/.ssh/id_rsa']) {
      await expect(git.add(runner, [hostile])).rejects.toThrow();
    }
  });

  /**
   * A file called `-f` is a filename. The `--` separator every write operation
   * uses is what keeps it one, and this proves the separator is there rather
   * than assumed.
   */
  test('git22 — a file whose name looks like a flag is treated as a file', async () => {
    await put('--not-a-flag', 'ordinary content\n');

    await git.add(runner, ['--not-a-flag']);

    const state = await git.status(runner);
    expect(state.files.some((file) => file.path.includes('not-a-flag'))).toBe(true);
    await git.unstage(runner, ['--not-a-flag']);
    await rm(`${WORKSPACE}/--not-a-flag`, { force: true });
  });

  /**
   * The container has `--network none`, and the git service offers no operation
   * that reaches the network. This asserts the first half from inside: even
   * spelled by hand, a fetch has nowhere to go.
   */
  test('git23 — the container git runs in has no network at all', async () => {
    const result = await runtime.runCommand(NAME, [
      'env',
      'GIT_TERMINAL_PROMPT=0',
      'git',
      'ls-remote',
      'https://github.com/git/git',
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /could not resolve|network is unreachable|unable to access|connect/i,
    );
  });

  /** Nothing the gateway knows is readable from inside the workspace. */
  test('git24 — no credential reaches the workspace or its git config', async () => {
    const found = await runtime.runCommand(NAME, [
      '/bin/sh',
      '-c',
      'cat .git/config 2>/dev/null; env; ls -a /home/dev 2>/dev/null',
    ]);
    const text = `${found.stdout}${found.stderr}`;

    expect(text).not.toMatch(/SUPABASE|SERVICE_ROLE|GEMINI|GITHUB_TOKEN|ghp_|github_pat_/);
  });
});
