import { create } from 'zustand';
import { workspaceGit, workspaceConnected } from '@/lib/ai/workspaceBridge';
import type { GitOperation } from '@/lib/terminal/protocol';

/**
 * Real git, in the project's container, as the IDE sees it.
 *
 * This store holds no repository of its own. Every field below is the answer to
 * a question asked of `git` in the workspace a moment ago, and nothing here is
 * derived, simulated or remembered across a container: when the workspace goes
 * away the state is cleared rather than left on screen, because a branch name
 * from a connection that no longer exists is a claim about a repository nobody
 * is reading.
 *
 * It is deliberately not the in-browser version control in `src/lib/vcs`. That
 * one is a real implementation of git's model over the virtual filesystem and
 * remains the default; this one is `git` itself, in the container, and the two
 * are shown as two sources in the panel rather than merged into a single
 * fiction.
 *
 * **Refresh is explicit.** There is no interval and no watcher. A status poll
 * is a `git status` in a container per tick, per open tab, forever; the panel
 * refreshes when it is opened, after an operation it performed, and when a
 * person asks.
 */

export interface WorkspaceGitFile {
  path: string;
  /** Two-letter porcelain code: index status, then worktree status. */
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface WorkspaceGitStatus {
  repository: boolean;
  branch: string | null;
  unborn: boolean;
  detached: boolean;
  files: WorkspaceGitFile[];
  dirty: boolean;
}

export interface WorkspaceGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  at: number;
  subject: string;
}

/**
 * A refusal the gateway made on safety grounds, held so the panel can offer the
 * confirmation rather than an error.
 *
 * `atRisk` is the list of paths that would be discarded. Naming them is the
 * point: "this will discard uncommitted changes" is a warning, and "this will
 * discard your changes to these four files" is information.
 */
export interface PendingConfirmation {
  operation: GitOperation;
  what: string;
  message: string;
  atRisk: string[];
}

interface WorkspaceGitState {
  /** True while any request is in flight, so the panel can disable its actions. */
  busy: boolean;
  /** True during the first load of a workspace, which is a skeleton not a spinner. */
  loading: boolean;
  /** A failure to *read*. A refused destructive operation is not this. */
  error: string | null;
  status: WorkspaceGitStatus | null;
  log: WorkspaceGitCommit[];
  branches: { current: string | null; all: string[] };
  /** A diff for the selected path, or null when nothing is selected. */
  selectedPath: string | null;
  diff: string | null;
  diffLoading: boolean;
  confirming: PendingConfirmation | null;

  refresh: () => Promise<void>;
  clear: () => void;
  select: (path: string | null, staged?: boolean) => Promise<void>;
  run: (operation: GitOperation, what: string) => Promise<WorkspaceGitOutcome>;
  confirm: () => Promise<WorkspaceGitOutcome>;
  cancelConfirmation: () => void;
}

/**
 * What one operation did.
 *
 * `applied` is false both for a failure and for a refusal awaiting
 * confirmation, and `awaitingConfirmation` distinguishes them — a caller that
 * toasts on failure must not toast when the panel is about to ask a question.
 */
export interface WorkspaceGitOutcome {
  applied: boolean;
  awaitingConfirmation: boolean;
  data?: unknown;
  message?: string;
}

const EMPTY_BRANCHES = { current: null as string | null, all: [] as string[] };

/** Operations that change the repository and so must be followed by a re-read. */
const MUTATING: ReadonlySet<GitOperation['op']> = new Set([
  'init',
  'add',
  'unstage',
  'commit',
  'create-branch',
  'checkout',
  'discard',
  'delete-branch',
]);

export const useWorkspaceGitStore = create<WorkspaceGitState>()((set, get) => ({
  busy: false,
  loading: false,
  error: null,
  status: null,
  log: [],
  branches: EMPTY_BRANCHES,
  selectedPath: null,
  diff: null,
  diffLoading: false,
  confirming: null,

  clear: () =>
    set({
      busy: false,
      loading: false,
      error: null,
      status: null,
      log: [],
      branches: EMPTY_BRANCHES,
      selectedPath: null,
      diff: null,
      diffLoading: false,
      confirming: null,
    }),

  /**
   * Read the repository: status, recent history, branches.
   *
   * Three requests rather than one, because the gateway's operations are typed
   * and each answers one question. They go out together — the gateway
   * correlates answers by request id, so serialising them would only make the
   * panel slower.
   */
  refresh: async () => {
    if (!workspaceConnected()) {
      get().clear();
      return;
    }
    set({ loading: get().status === null, error: null });
    try {
      const [status, log, branches] = await Promise.all([
        workspaceGit({ op: 'status' }),
        workspaceGit({ op: 'log', limit: 50 }),
        workspaceGit({ op: 'branches' }),
      ]);

      if (!status.ok) {
        set({ loading: false, error: status.message ?? 'Could not read the repository.' });
        return;
      }

      const state = status.data as WorkspaceGitStatus;
      set({
        loading: false,
        error: null,
        status: state,
        // A repository with no commits has no log and no branches, and the
        // gateway says so by answering empty rather than by failing.
        log: log.ok ? ((log.data as WorkspaceGitCommit[]) ?? []) : [],
        branches: branches.ok
          ? ((branches.data as { current: string | null; all: string[] }) ?? EMPTY_BRANCHES)
          : EMPTY_BRANCHES,
      });

      // A path that is no longer changed has no diff to show.
      const selected = get().selectedPath;
      if (selected && !state.files.some((file) => file.path === selected)) {
        set({ selectedPath: null, diff: null });
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'The workspace did not answer.',
      });
    }
  },

  /**
   * Read the diff for one path.
   *
   * `staged` says which side is wanted, and it comes from the row that was
   * clicked rather than from the file's flags: a partially staged file appears
   * in both lists, and inferring the side from `file.staged` would show the
   * index's diff to somebody who clicked the working tree's row.
   */
  select: async (path, staged = false) => {
    if (!path) {
      set({ selectedPath: null, diff: null, diffLoading: false });
      return;
    }
    set({ selectedPath: path, diff: null, diffLoading: true });
    try {
      const file = get().status?.files.find((entry) => entry.path === path);
      // An untracked file has no diff against the index; `git diff` on it is
      // silent, which would read as "no change" for a file that is entirely new.
      if (file?.untracked) {
        set({ diffLoading: false, diff: null });
        return;
      }
      const answer = await workspaceGit({ op: 'diff', staged, path });
      if (get().selectedPath !== path) return; // a later selection won
      set({
        diffLoading: false,
        diff: answer.ok ? String(answer.data ?? '') : null,
      });
    } catch {
      if (get().selectedPath === path) set({ diffLoading: false, diff: null });
    }
  },

  /**
   * Perform one operation, and hold a safety refusal instead of reporting it as
   * a failure.
   *
   * The gateway answers a destructive operation that would lose work with
   * `needsConfirmation` and the paths at risk. That is not an error — nothing
   * went wrong — so it becomes a confirmation the person can accept or decline,
   * and only an accepted one is sent again with `confirm`.
   *
   * Returns what happened, so a caller can tell a refusal from a failure.
   */
  run: async (operation, what) => {
    if (!workspaceConnected()) {
      const message = 'No container workspace is connected.';
      set({ error: message });
      return { applied: false, awaitingConfirmation: false, message };
    }
    set({ busy: true });
    try {
      const answer = await workspaceGit(operation);
      if (!answer.ok && answer.needsConfirmation) {
        const message = answer.message ?? `${what} would discard uncommitted changes.`;
        set({
          busy: false,
          confirming: { operation, what, message, atRisk: answer.atRisk ?? [] },
        });
        return { applied: false, awaitingConfirmation: true, message };
      }
      const message = answer.ok ? undefined : (answer.message ?? `${what} failed.`);
      set({ busy: false, error: message ?? null });
      if (answer.ok && MUTATING.has(operation.op)) await get().refresh();
      return { applied: answer.ok, awaitingConfirmation: false, data: answer.data, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The workspace did not answer.';
      set({ busy: false, error: message });
      return { applied: false, awaitingConfirmation: false, message };
    }
  },

  /** Re-send the held operation, this time with the confirmation the gateway asked for. */
  confirm: async () => {
    const pending = get().confirming;
    if (!pending) return { applied: false, awaitingConfirmation: false };
    set({ confirming: null });
    return get().run({ ...pending.operation, confirm: true } as GitOperation, pending.what);
  },

  cancelConfirmation: () => set({ confirming: null }),
}));
