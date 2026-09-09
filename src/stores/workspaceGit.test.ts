import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitOperation } from '@/lib/terminal/protocol';

/**
 * The IDE's view of real git, and the two properties that make it trustworthy.
 *
 * The first is that it never shows a repository it did not read. With no
 * container attached the state is cleared rather than left on screen, because
 * the alternative — a branch name and a file list from a workspace that is gone
 * — is the panel telling somebody about a repository nobody is looking at.
 *
 * The second is that a destructive refusal stays a refusal. The gateway answers
 * a `checkout` or `discard` that would lose work with `needsConfirmation` and
 * the paths at risk. If that arrived as a plain failure the person would be
 * told the operation broke; if it were re-sent with `confirm` automatically,
 * the safety check would be a formality that always passes. It has to become a
 * question, and only an answered question may send `confirm`.
 */

const answers = vi.fn<(request: GitOperation) => Promise<Record<string, unknown>>>();
const connected = vi.fn(() => true);

vi.mock('@/lib/ai/workspaceBridge', () => ({
  workspaceGit: (request: GitOperation) => answers(request),
  workspaceConnected: () => connected(),
  subscribeWorkspace: () => () => undefined,
  workspaceContainerId: () => 'tacode-test',
}));

const { useWorkspaceGitStore } = await import('@/stores/workspaceGitStore');

const CLEAN = {
  repository: true,
  branch: 'main',
  unborn: false,
  detached: false,
  files: [],
  dirty: false,
};

const DIRTY = {
  ...CLEAN,
  dirty: true,
  files: [
    { path: 'src/app.ts', code: '.M', staged: false, unstaged: true, untracked: false },
    { path: 'notes.md', code: '??', staged: false, unstaged: false, untracked: true },
  ],
};

/** Answer each operation by its `op`, so a test names only what it cares about. */
function replying(byOp: Partial<Record<GitOperation['op'], Record<string, unknown>>>) {
  answers.mockImplementation(async (request) => {
    const reply = byOp[request.op];
    if (reply) return reply;
    switch (request.op) {
      case 'status':
        return { ok: true, data: CLEAN };
      case 'log':
        return { ok: true, data: [] };
      case 'branches':
        return { ok: true, data: { current: 'main', all: ['main'] } };
      default:
        return { ok: true, data: null };
    }
  });
}

beforeEach(() => {
  answers.mockReset();
  connected.mockReset();
  connected.mockReturnValue(true);
  useWorkspaceGitStore.getState().clear();
  replying({});
});

describe('reading a workspace repository', () => {
  it('reports what git said, not what it remembered', async () => {
    replying({ status: { ok: true, data: DIRTY } });

    await useWorkspaceGitStore.getState().refresh();

    const state = useWorkspaceGitStore.getState();
    expect(state.status?.branch).toBe('main');
    expect(state.status?.files.map((file) => file.path)).toEqual(['src/app.ts', 'notes.md']);
    expect(state.error).toBeNull();
  });

  /**
   * The panel must not keep a branch name from a connection that no longer
   * exists. That state would look exactly like a live reading and be a claim
   * about a container nobody is attached to.
   */
  it('clears everything when there is no workspace rather than keeping the last reading', async () => {
    replying({ status: { ok: true, data: DIRTY } });
    await useWorkspaceGitStore.getState().refresh();
    expect(useWorkspaceGitStore.getState().status).not.toBeNull();

    connected.mockReturnValue(false);
    await useWorkspaceGitStore.getState().refresh();

    expect(useWorkspaceGitStore.getState().status).toBeNull();
    expect(useWorkspaceGitStore.getState().log).toEqual([]);
  });

  it('surfaces a read failure instead of rendering an empty clean repository', async () => {
    replying({ status: { ok: false, message: 'Could not read the repository status.' } });

    await useWorkspaceGitStore.getState().refresh();

    const state = useWorkspaceGitStore.getState();
    expect(state.status).toBeNull();
    expect(state.error).toMatch(/could not read/i);
  });

  it('shows a workspace with no repository as having none, not as clean', async () => {
    replying({
      status: {
        ok: true,
        data: { repository: false, branch: null, unborn: false, detached: false, files: [], dirty: false },
      },
    });

    await useWorkspaceGitStore.getState().refresh();

    expect(useWorkspaceGitStore.getState().status?.repository).toBe(false);
  });

  /**
   * An unborn branch has no `log` and no `branches`, and git says so by exiting
   * non-zero. That is not a failure of the panel's read.
   */
  it('reads a repository with no commits without reporting an error', async () => {
    replying({
      status: { ok: true, data: { ...CLEAN, branch: 'main', unborn: true } },
      log: { ok: true, data: [] },
      branches: { ok: true, data: { current: 'main', all: [] } },
    });

    await useWorkspaceGitStore.getState().refresh();

    const state = useWorkspaceGitStore.getState();
    expect(state.error).toBeNull();
    expect(state.status?.unborn).toBe(true);
    expect(state.log).toEqual([]);
  });
});

describe('a destructive operation the gateway refuses', () => {
  it('becomes a question naming the files at risk, not an error', async () => {
    replying({
      status: { ok: true, data: DIRTY },
      discard: {
        ok: false,
        needsConfirmation: true,
        message: 'Discarding would discard uncommitted changes in 1 file.',
        atRisk: ['src/app.ts'],
      },
    });

    const outcome = await useWorkspaceGitStore
      .getState()
      .run({ op: 'discard', paths: ['src/app.ts'] }, 'Discarding changes');

    expect(outcome.applied).toBe(false);
    expect(outcome.awaitingConfirmation).toBe(true);
    const state = useWorkspaceGitStore.getState();
    expect(state.error).toBeNull();
    expect(state.confirming?.atRisk).toEqual(['src/app.ts']);
  });

  /** The first send must never carry `confirm`, or the check is decorative. */
  it('sends the operation unconfirmed first', async () => {
    replying({
      discard: { ok: false, needsConfirmation: true, message: 'would discard', atRisk: [] },
    });

    await useWorkspaceGitStore.getState().run({ op: 'discard', paths: ['a.ts'] }, 'Discarding');

    expect(answers).toHaveBeenCalledWith({ op: 'discard', paths: ['a.ts'] });
  });

  it('only sends confirm after the confirmation was accepted', async () => {
    replying({
      status: { ok: true, data: CLEAN },
      discard: { ok: false, needsConfirmation: true, message: 'would discard', atRisk: ['a.ts'] },
    });
    await useWorkspaceGitStore.getState().run({ op: 'discard', paths: ['a.ts'] }, 'Discarding');

    replying({ status: { ok: true, data: CLEAN }, discard: { ok: true, data: CLEAN } });
    await useWorkspaceGitStore.getState().confirm();

    expect(answers).toHaveBeenCalledWith({ op: 'discard', paths: ['a.ts'], confirm: true });
    expect(useWorkspaceGitStore.getState().confirming).toBeNull();
  });

  it('sends nothing at all when the confirmation is declined', async () => {
    replying({
      discard: { ok: false, needsConfirmation: true, message: 'would discard', atRisk: ['a.ts'] },
    });
    await useWorkspaceGitStore.getState().run({ op: 'discard', paths: ['a.ts'] }, 'Discarding');
    const sent = answers.mock.calls.length;

    useWorkspaceGitStore.getState().cancelConfirmation();

    expect(answers.mock.calls.length).toBe(sent);
    expect(useWorkspaceGitStore.getState().confirming).toBeNull();
  });
});

describe('an operation that changes the repository', () => {
  it('re-reads git afterwards rather than trusting its own idea of the result', async () => {
    replying({ status: { ok: true, data: CLEAN }, commit: { ok: true, data: { hash: 'abc123def', subject: 'ok' } } });

    const outcome = await useWorkspaceGitStore.getState().run({ op: 'commit', message: 'ok' }, 'Commit');

    expect(outcome.applied).toBe(true);
    expect(answers.mock.calls.filter((call) => call[0].op === 'status').length).toBeGreaterThan(0);
  });

  /** A failed commit is reported as failed. Nothing here rounds it up. */
  it('reports a failure as a failure', async () => {
    replying({ commit: { ok: false, message: 'There is nothing staged to commit.' } });

    const outcome = await useWorkspaceGitStore.getState().run({ op: 'commit', message: 'x' }, 'Commit');

    expect(outcome.applied).toBe(false);
    expect(outcome.awaitingConfirmation).toBe(false);
    expect(outcome.message).toMatch(/nothing staged/i);
  });

  it('refuses to act at all with no workspace attached', async () => {
    connected.mockReturnValue(false);

    const outcome = await useWorkspaceGitStore.getState().run({ op: 'commit', message: 'x' }, 'Commit');

    expect(outcome.applied).toBe(false);
    expect(answers).not.toHaveBeenCalled();
    expect(useWorkspaceGitStore.getState().error).toMatch(/no container workspace/i);
  });

  it('does not re-read after a read-only operation', async () => {
    replying({ diff: { ok: true, data: '' } });

    await useWorkspaceGitStore.getState().run({ op: 'diff' }, 'Diff');

    expect(answers.mock.calls.filter((call) => call[0].op === 'status').length).toBe(0);
  });
});

describe('selecting a file to diff', () => {
  it('asks git for the diff of that path', async () => {
    replying({ status: { ok: true, data: DIRTY }, diff: { ok: true, data: '@@ -1 +1 @@\n-a\n+b\n' } });
    await useWorkspaceGitStore.getState().refresh();

    await useWorkspaceGitStore.getState().select('src/app.ts');

    expect(answers).toHaveBeenCalledWith({ op: 'diff', staged: false, path: 'src/app.ts' });
    expect(useWorkspaceGitStore.getState().diff).toContain('+b');
  });

  /**
   * A file can be staged *and* modified again, and then it appears in both
   * lists. Which diff to show is decided by the row that was clicked, not by
   * the file's flags — inferring it would show the index's diff to somebody
   * who clicked the working tree's row.
   */
  it('reads the side the caller asked for on a partially staged file', async () => {
    replying({
      status: {
        ok: true,
        data: {
          ...CLEAN,
          dirty: true,
          files: [{ path: 'both.ts', code: 'MM', staged: true, unstaged: true, untracked: false }],
        },
      },
      diff: { ok: true, data: 'patch' },
    });
    await useWorkspaceGitStore.getState().refresh();

    await useWorkspaceGitStore.getState().select('both.ts', true);
    expect(answers).toHaveBeenCalledWith({ op: 'diff', staged: true, path: 'both.ts' });

    await useWorkspaceGitStore.getState().select('both.ts', false);
    expect(answers).toHaveBeenCalledWith({ op: 'diff', staged: false, path: 'both.ts' });
  });

  /**
   * `git diff` says nothing about an untracked file. Asking anyway and showing
   * the empty answer would read as "this file has not changed" for a file that
   * is entirely new.
   */
  it('does not ask for a diff of an untracked file', async () => {
    replying({ status: { ok: true, data: DIRTY } });
    await useWorkspaceGitStore.getState().refresh();
    answers.mockClear();

    await useWorkspaceGitStore.getState().select('notes.md');

    expect(answers.mock.calls.filter((call) => call[0].op === 'diff').length).toBe(0);
  });

  it('drops a selection for a file git no longer reports as changed', async () => {
    replying({ status: { ok: true, data: DIRTY }, diff: { ok: true, data: 'x' } });
    await useWorkspaceGitStore.getState().refresh();
    await useWorkspaceGitStore.getState().select('src/app.ts');

    replying({ status: { ok: true, data: CLEAN } });
    await useWorkspaceGitStore.getState().refresh();

    expect(useWorkspaceGitStore.getState().selectedPath).toBeNull();
    expect(useWorkspaceGitStore.getState().diff).toBeNull();
  });
});
