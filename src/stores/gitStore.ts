import { create } from 'zustand';
import * as vcs from '@/lib/vcs';
import type { Commit, Repo, RepoStatus } from '@/lib/vcs';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { useFileStore } from '@/stores/fileStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { recordActivity } from '@/stores/activityStore';
import { errorMessage } from '@/lib/utils';
import type { ShellLine } from '@/lib/shell';
import { githubClient } from '@/lib/github/gateway';
import { GithubError } from '@/lib/github/errors';
import {
  completeMerge,
  newRemoteRef,
  syncStatus,
  type RemoteRef,
  type SyncStatus,
} from '@/lib/github/remote';
import {
  explainPushRejection,
  fetchRemote,
  outgoingCommits,
  pullRemote,
  pushRemote,
} from '@/lib/github/sync';
import type { GithubBranch, GithubCommitRef, GithubRepo } from '@/lib/github/types';
import { assertBranchName } from '@/lib/github/identifiers';

/**
 * Version control state.
 *
 * Backed by Forge VCS (see `lib/vcs.ts`) — real commits, branches, diffs and
 * merges held in the project's own storage — with a real GitHub remote layered
 * on top (`lib/github/*`). Fetch, pull and push talk to the GitHub Git Data
 * API and produce genuine git objects; GitHub itself decides whether a ref
 * update is a fast-forward. Nothing here reports success that GitHub has not
 * confirmed.
 */

/** Only one remote operation may run at a time, per project. */
export type RemoteOperation = 'fetch' | 'pull' | 'push' | 'connect' | 'branch' | null;

export interface RemoteResult {
  ok: boolean;
  message: string;
  detail?: string;
  conflicts?: string[];
  sha?: string;
}

interface GitState {
  repo: Repo;
  status: RepoStatus;
  history: Commit[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  /** Which side of the diff the viewer is showing. */
  diffAgainst: 'head' | 'index';

  load: (projectId: string) => Promise<void>;
  refresh: () => void;
  init: () => Promise<void>;
  stage: (paths?: string[]) => Promise<void>;
  unstage: (paths?: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<Commit>;
  createBranch: (name: string, checkoutAfter?: boolean) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  merge: (branch: string) => Promise<{ conflicts: string[]; fastForward: boolean; upToDate: boolean }>;
  select: (path: string | null, against?: 'head' | 'index') => void;
  runCommand: (args: string[]) => Promise<ShellLine[]>;

  // --- remote ------------------------------------------------------------
  remote: RemoteRef | null;
  remoteBusy: RemoteOperation;
  remoteError: string | null;
  /** Commits on the remote that local history does not have, from the last fetch. */
  incoming: GithubCommitRef[];
  behind: number;
  remoteBranches: GithubBranch[];

  sync: () => SyncStatus;
  outgoing: () => Commit[];
  connectRemote: (repo: GithubRepo, branch?: string) => Promise<void>;
  disconnectRemote: () => Promise<void>;
  setRemoteBranch: (branch: string) => Promise<void>;
  fetchRemote: () => Promise<RemoteResult>;
  pullRemote: () => Promise<RemoteResult>;
  pushRemote: () => Promise<RemoteResult>;
  commitAndPush: (message: string) => Promise<RemoteResult>;
  refreshRemoteBranches: () => Promise<GithubBranch[]>;
  deleteRemoteBranch: (branch: string) => Promise<void>;
}

const EMPTY_STATUS: RepoStatus = { branch: 'main', staged: [], unstaged: [], clean: true };

function author() {
  const user = useAuthStore.getState().user;
  return { name: user?.displayName ?? 'Local Developer', email: user?.email ?? 'you@localhost' };
}

async function persist(repo: Repo) {
  const projectId = useFileStore.getState().projectId;
  if (!projectId) return;
  await repositoryFor(useAuthStore.getState().user?.provider).saveVcs(projectId, repo);
}

async function persistRemote(remote: RemoteRef | null) {
  const projectId = useFileStore.getState().projectId;
  if (!projectId) return;
  const store = repositoryFor(useAuthStore.getState().user?.provider);
  if (remote) await store.saveRemote(projectId, remote);
  else await store.clearRemote(projectId);
}

/**
 * Serialise remote operations.
 *
 * Two fetches racing is merely wasteful; two pushes racing would each build
 * git objects against the same parent and one would lose. A single in-flight
 * slot per project is enough, and it is what keeps the buttons honest about
 * being disabled.
 */
async function runRemote(
  operation: Exclude<RemoteOperation, null>,
  work: (remote: RemoteRef, projectId: string | undefined) => Promise<RemoteResult>,
): Promise<RemoteResult> {
  const state = useGitStore.getState();
  if (state.remoteBusy) {
    return { ok: false, message: `A ${state.remoteBusy} is already running.` };
  }
  const remote = state.remote;
  if (!remote) {
    return { ok: false, message: 'This project is not connected to a GitHub repository.' };
  }
  useGitStore.setState({ remoteBusy: operation, remoteError: null });
  try {
    const result = await work(remote, useFileStore.getState().projectId ?? undefined);
    if (!result.ok) useGitStore.setState({ remoteError: result.detail ?? result.message });
    return result;
  } catch (error) {
    const message =
      error instanceof GithubError ? error.message : errorMessage(error);
    useGitStore.setState({ remoteError: message });
    return { ok: false, message: 'GitHub request failed', detail: message };
  } finally {
    useGitStore.setState({ remoteBusy: null });
  }
}

/** Replace the working tree with `files`, through the file store's own guards. */
async function applyWorkingTree(files: Record<string, string>) {
  const fileStore = useFileStore.getState();
  for (const path of Object.keys(fileStore.files)) {
    if (!(path in files)) fileStore.remove(path);
  }
  for (const [path, content] of Object.entries(files)) {
    if (useFileStore.getState().files[path] !== content) fileStore.writeFile(path, content);
  }
  await fileStore.flush();
}

export const useGitStore = create<GitState>()((set, get) => ({
  repo: vcs.emptyRepo(),
  status: EMPTY_STATUS,
  history: [],
  loading: false,
  error: null,
  selectedPath: null,
  diffAgainst: 'head',
  remote: null,
  remoteBusy: null,
  remoteError: null,
  incoming: [],
  behind: 0,
  remoteBranches: [],

  async load(projectId) {
    set({ loading: true, error: null });
    try {
      const store = repositoryFor(useAuthStore.getState().user?.provider);
      const stored = await store.loadVcs(projectId);
      const remote = await store.loadRemote(projectId).catch(() => null);
      const repo = stored ?? vcs.emptyRepo();
      set({
        repo,
        remote,
        remoteBusy: null,
        remoteError: null,
        incoming: [],
        behind: 0,
        remoteBranches: [],
        status: repo.initialized ? vcs.status(repo, useFileStore.getState().files) : EMPTY_STATUS,
        history: repo.initialized ? vcs.log(repo) : [],
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  refresh() {
    const { repo } = get();
    if (!repo.initialized) return;
    set({
      status: vcs.status(repo, useFileStore.getState().files),
      history: vcs.log(repo),
    });
  },

  async init() {
    const repo = vcs.initRepo(useSettingsStore.getState().git.defaultBranch);
    set({ repo, status: vcs.status(repo, useFileStore.getState().files), history: [] });
    await persist(repo);
  },

  async stage(paths) {
    const repo = vcs.stage(get().repo, useFileStore.getState().files, paths);
    set({ repo, status: vcs.status(repo, useFileStore.getState().files) });
    await persist(repo);
  },

  async unstage(paths) {
    const repo = vcs.unstage(get().repo, paths);
    set({ repo, status: vcs.status(repo, useFileStore.getState().files) });
    await persist(repo);
  },

  async discard(paths) {
    const fileStore = useFileStore.getState();
    fileStore.assertWritable();
    const restored = vcs.discard(get().repo, fileStore.files, paths);
    for (const path of paths) {
      if (path in restored) fileStore.writeFile(path, restored[path]);
      else fileStore.remove(path);
    }
    await fileStore.flush();
    get().refresh();
  },

  async commit(message) {
    const previousHead = get().repo.branches[get().repo.head] || null;
    const repo = vcs.commit(get().repo, message, author());
    const created = vcs.log(repo)[0];
    set({ repo, status: vcs.status(repo, useFileStore.getState().files), history: vcs.log(repo) });
    await persist(repo);
    recordActivity('commit.created', `${created.id.slice(0, 7)} ${created.message}`);

    // A commit made while a pull is conflicted is the resolution, and it is
    // what completes that merge — the same role `git commit` plays after a
    // conflicted `git pull`.
    const remote = get().remote;
    if (remote?.merging) {
      const merged = completeMerge(remote, previousHead);
      set({ remote: merged, incoming: [], behind: 0 });
      await persistRemote(merged);
    }
    return created;
  },

  async createBranch(name, checkoutAfter = true) {
    let repo = vcs.createBranch(get().repo, name);
    if (checkoutAfter) repo = { ...repo, head: name.trim() };
    set({ repo, status: vcs.status(repo, useFileStore.getState().files), history: vcs.log(repo) });
    await persist(repo);
    recordActivity('branch.created', name.trim());
  },

  async deleteBranch(name) {
    const repo = vcs.deleteBranch(get().repo, name);
    set({ repo });
    await persist(repo);
    recordActivity('branch.deleted', name);
  },

  async checkout(branch) {
    const fileStore = useFileStore.getState();
    fileStore.assertWritable();
    const result = vcs.checkout(get().repo, fileStore.files, branch);
    // Replace the working tree with the branch's snapshot.
    for (const path of Object.keys(fileStore.files)) {
      if (!(path in result.files)) fileStore.remove(path);
    }
    for (const [path, content] of Object.entries(result.files)) {
      if (fileStore.files[path] !== content) fileStore.writeFile(path, content);
    }
    await fileStore.flush();
    set({
      repo: result.repo,
      status: vcs.status(result.repo, result.files),
      history: vcs.log(result.repo),
    });
    await persist(result.repo);
    recordActivity('branch.switched', branch);
  },

  async merge(branch) {
    const fileStore = useFileStore.getState();
    fileStore.assertWritable();
    const outcome = vcs.merge(get().repo, fileStore.files, branch, author());
    if (!outcome.alreadyUpToDate) {
      for (const path of Object.keys(fileStore.files)) {
        if (!(path in outcome.files)) fileStore.remove(path);
      }
      for (const [path, content] of Object.entries(outcome.files)) {
        if (fileStore.files[path] !== content) fileStore.writeFile(path, content);
      }
      await fileStore.flush();
    }
    set({
      repo: outcome.repo,
      status: vcs.status(outcome.repo, outcome.files),
      history: vcs.log(outcome.repo),
    });
    await persist(outcome.repo);
    return {
      conflicts: outcome.conflicts,
      fastForward: outcome.fastForward,
      upToDate: outcome.alreadyUpToDate,
    };
  },

  select: (path, against = 'head') => set({ selectedPath: path, diffAgainst: against }),

  // --- remote --------------------------------------------------------------

  sync() {
    return syncStatus(get().repo, get().remote, get().behind);
  },

  outgoing() {
    const remote = get().remote;
    return remote ? outgoingCommits(get().repo, remote) : [];
  },

  async connectRemote(repo, branch) {
    useFileStore.getState().assertWritable();
    const remote = newRemoteRef({
      owner: repo.owner,
      repo: repo.name,
      repoId: repo.id,
      defaultBranch: repo.defaultBranch,
      branch: branch ?? repo.defaultBranch,
    });
    set({ remote, incoming: [], behind: 0, remoteError: null, remoteBranches: [] });
    await persistRemote(remote);
  },

  async disconnectRemote() {
    useFileStore.getState().assertWritable();
    set({ remote: null, incoming: [], behind: 0, remoteBranches: [], remoteError: null });
    await persistRemote(null);
  },

  async setRemoteBranch(branch) {
    const remote = get().remote;
    if (!remote) throw new Error('This project is not connected to a repository.');
    useFileStore.getState().assertWritable();
    // Switching the tracked branch invalidates everything we knew about the
    // old one; a fetch has to establish the new baseline before a push.
    const next: RemoteRef = {
      ...remote,
      branch: assertBranchName(branch),
      lastFetchedSha: null,
      lastSyncedSha: null,
      lastFetchedAt: null,
      syncedTree: null,
    };
    set({ remote: next, incoming: [], behind: 0 });
    await persistRemote(next);
  },

  /**
   * Guard every remote operation: one at a time, and never while another is
   * in flight. Two concurrent pushes would race on the same ref.
   */
  async fetchRemote() {
    return runRemote('fetch', async (remote, projectId) => {
      const client = githubClient(projectId);
      const result = await fetchRemote(client, get().repo, remote);
      set({ remote: result.remote, incoming: result.incoming, behind: result.behind });
      await persistRemote(result.remote);
      if (!result.remoteSha) {
        return { ok: true, message: `${remote.branch} does not exist on GitHub yet.` };
      }
      if (!result.behind) return { ok: true, message: 'Already up to date.' };
      return {
        ok: true,
        message: `${result.behind} incoming commit${result.behind === 1 ? '' : 's'} on ${remote.branch}.`,
        sha: result.remoteSha,
      };
    });
  },

  async pullRemote() {
    return runRemote('pull', async (remote, projectId) => {
      const fileStore = useFileStore.getState();
      fileStore.assertWritable();
      const client = githubClient(projectId);
      const outcome = await pullRemote(client, get().repo, remote, fileStore.files, author());

      if (outcome.kind === 'up-to-date') {
        set({ remote: outcome.remote, incoming: [], behind: 0 });
        await persistRemote(outcome.remote);
        return { ok: true, message: 'Already up to date.' };
      }
      if (outcome.kind === 'blocked') {
        set({ remote: outcome.remote });
        await persistRemote(outcome.remote);
        return { ok: false, message: 'Cannot pull', detail: outcome.reason };
      }

      await applyWorkingTree(outcome.files);
      set({
        repo: outcome.repo,
        remote: outcome.remote,
        status: vcs.status(outcome.repo, useFileStore.getState().files),
        history: vcs.log(outcome.repo),
        incoming: outcome.conflicts.length ? get().incoming : [],
        behind: outcome.conflicts.length ? get().behind : 0,
      });
      await persist(outcome.repo);
      await persistRemote(outcome.remote);

      if (outcome.kind === 'conflicts') {
        return {
          ok: false,
          message: `Conflicts in ${outcome.conflicts.length} file${outcome.conflicts.length === 1 ? '' : 's'}`,
          detail: 'Conflict markers were written into the files. Resolve them, stage and commit.',
          conflicts: outcome.conflicts,
        };
      }
      recordActivity('remote.pulled', `${remote.owner}/${remote.repo} ${remote.branch}`);
      return {
        ok: true,
        message: outcome.kind === 'fast-forward' ? 'Fast-forwarded.' : 'Merged successfully.',
        sha: outcome.toSha,
      };
    });
  },

  async pushRemote() {
    return runRemote('push', async (remote, projectId) => {
      const fileStore = useFileStore.getState();
      fileStore.assertWritable();
      const client = githubClient(projectId);
      try {
        const outcome = await pushRemote(client, get().repo, remote, fileStore.files);
        if (outcome.kind === 'nothing-to-push') {
          set({ remote: outcome.remote, behind: 0 });
          await persistRemote(outcome.remote);
          return { ok: true, message: 'Everything is already on GitHub.' };
        }
        if (outcome.kind === 'blocked') {
          set({ remote: outcome.remote });
          await persistRemote(outcome.remote);
          return { ok: false, message: 'Cannot push', detail: outcome.reason };
        }
        set({ remote: outcome.remote, incoming: [], behind: 0 });
        await persistRemote(outcome.remote);
        recordActivity('remote.pushed', `${remote.owner}/${remote.repo} ${remote.branch}`);
        return {
          ok: true,
          message: outcome.createdBranch
            ? `Created ${remote.branch} on GitHub at ${outcome.sha.slice(0, 7)}.`
            : `Pushed ${outcome.commits} commit${outcome.commits === 1 ? '' : 's'} — ${outcome.sha.slice(0, 7)}.`,
          sha: outcome.sha,
        };
      } catch (error) {
        // The local repository is untouched by a failed push; say why it failed.
        return { ok: false, message: 'Push rejected', detail: explainPushRejection(error) };
      }
    });
  },

  async commitAndPush(message) {
    let created: Commit;
    try {
      created = await get().commit(message);
    } catch (error) {
      return { ok: false, message: 'Commit failed', detail: errorMessage(error) };
    }
    const pushed = await get().pushRemote();
    if (pushed.ok) return pushed;
    return {
      ...pushed,
      message: 'Commit created locally, but push failed',
      detail: `${created.id.slice(0, 7)} is safe in your local history. ${pushed.detail ?? ''}`.trim(),
    };
  },

  async refreshRemoteBranches() {
    const remote = get().remote;
    if (!remote) return [];
    const client = githubClient(useFileStore.getState().projectId ?? undefined);
    const page = await client.listBranches(remote);
    set({ remoteBranches: page.items });
    return page.items;
  },

  async deleteRemoteBranch(branch) {
    const remote = get().remote;
    if (!remote) throw new Error('This project is not connected to a repository.');
    useFileStore.getState().assertWritable();
    const name = assertBranchName(branch);
    if (name === remote.defaultBranch) {
      throw new Error(`${name} is the default branch on GitHub and cannot be deleted from Forge.`);
    }
    const client = githubClient(useFileStore.getState().projectId ?? undefined);
    await client.deleteBranch(remote, name);
    set({ remoteBranches: get().remoteBranches.filter((b) => b.name !== name) });
  },


  async runCommand(args) {
    const out = (text: string): ShellLine => ({ kind: 'stdout', text });
    const err = (text: string): ShellLine => ({ kind: 'stderr', text });
    const info = (text: string): ShellLine => ({ kind: 'info', text });
    const sub = args[0];
    const state = get();

    if (!sub) {
      return [
        info('Forge VCS — local, git-style version control. Subcommands:'),
        out('  init, status, add, reset, commit -m <msg>, log, branch, checkout, merge, diff'),
        out('  remote, fetch, pull, push  (against the connected GitHub repository)'),
        info('Connect a repository from the Source Control panel to enable the network commands.'),
      ];
    }

    if (sub !== 'init' && !state.repo.initialized) {
      return [err('fatal: not a Forge VCS repository. Run "git init" first.')];
    }

    try {
      switch (sub) {
        case 'init': {
          if (state.repo.initialized) return [info('Repository already initialized')];
          await state.init();
          return [info('Initialized empty Forge VCS repository on branch "main"')];
        }
        case 'status': {
          state.refresh();
          const status = get().status;
          const lines: ShellLine[] = [out(`On branch ${status.branch}`)];
          if (status.clean) return [...lines, info('nothing to commit, working tree clean')];
          if (status.staged.length) {
            lines.push(out('Changes to be committed:'));
            status.staged.forEach((c) => lines.push(out(`  ${c.status.padEnd(9)}${c.path}`)));
          }
          if (status.unstaged.length) {
            lines.push(out('Changes not staged for commit:'));
            status.unstaged.forEach((c) => lines.push(out(`  ${c.status.padEnd(9)}${c.path}`)));
          }
          return lines;
        }
        case 'add': {
          const paths = args.slice(1).filter((a) => a !== '.' && a !== '-A');
          await state.stage(paths.length ? paths : undefined);
          return [info(paths.length ? `staged ${paths.join(', ')}` : 'staged all changes')];
        }
        case 'reset': {
          const paths = args.slice(1);
          await state.unstage(paths.length ? paths : undefined);
          return [info('unstaged changes')];
        }
        case 'commit': {
          const messageIndex = args.findIndex((a) => a === '-m');
          if (messageIndex === -1 || !args[messageIndex + 1]) {
            return [err('error: commit requires a message: git commit -m "your message"')];
          }
          const created = await state.commit(args.slice(messageIndex + 1).join(' '));
          return [out(`[${state.status.branch} ${created.id.slice(0, 7)}] ${created.message}`)];
        }
        case 'log': {
          state.refresh();
          const history = get().history.slice(0, 20);
          if (!history.length) return [info('no commits yet')];
          return history.map((c) =>
            out(`${c.id.slice(0, 7)}  ${new Date(c.timestamp).toLocaleString()}  ${c.author}  ${c.message}`),
          );
        }
        case 'branch': {
          const name = args[1];
          if (!name) {
            return Object.keys(state.repo.branches)
              .sort()
              .map((b) => out(`${b === state.repo.head ? '* ' : '  '}${b}`));
          }
          if (args.includes('-d')) {
            await state.deleteBranch(args[args.indexOf('-d') + 1] ?? name);
            return [info(`deleted branch ${name}`)];
          }
          await state.createBranch(name, false);
          return [info(`created branch ${name}`)];
        }
        case 'checkout': {
          const name = args[1];
          if (!name) return [err('error: checkout requires a branch name')];
          if (args.includes('-b')) {
            const target = args[args.indexOf('-b') + 1];
            await state.createBranch(target, true);
            return [info(`switched to a new branch "${target}"`)];
          }
          await state.checkout(name);
          return [info(`switched to branch "${name}"`)];
        }
        case 'merge': {
          const name = args[1];
          if (!name) return [err('error: merge requires a branch name')];
          const result = await state.merge(name);
          if (result.upToDate) return [info('Already up to date.')];
          if (result.fastForward) return [info(`Fast-forward to ${name}`)];
          if (result.conflicts.length) {
            return [
              err(`CONFLICT: ${result.conflicts.length} file(s) need manual resolution:`),
              ...result.conflicts.map((p) => err(`  ${p}`)),
              info('Conflict markers were written into the files. Resolve them, then commit.'),
            ];
          }
          return [info(`Merged ${name}`)];
        }
        case 'diff': {
          state.refresh();
          const status = get().status;
          const changes = [...status.unstaged, ...status.staged];
          if (!changes.length) return [info('no changes')];
          const { diffStat } = await import('@/lib/diff');
          const files = useFileStore.getState().files;
          return changes.map((change) => {
            const before = vcs.headContent(get().repo, change.path);
            const after = files[change.path] ?? '';
            const stat = diffStat(before, after);
            return out(`${change.path}  +${stat.additions} -${stat.deletions}`);
          });
        }
        case 'remote': {
          const remote = get().remote;
          if (!remote) return [info('No remote configured. Connect one in Source Control.')];
          return [
            out(`origin  https://github.com/${remote.owner}/${remote.repo}.git (fetch)`),
            out(`origin  https://github.com/${remote.owner}/${remote.repo}.git (push)`),
            info(`tracking branch: ${remote.branch}`),
          ];
        }
        case 'fetch':
        case 'pull':
        case 'push': {
          if (!get().remote) {
            return [
              err(`fatal: no remote configured for ${sub}.`),
              info('Connect a GitHub repository from the Source Control panel first.'),
            ];
          }
          const result =
            sub === 'fetch'
              ? await state.fetchRemote()
              : sub === 'pull'
                ? await state.pullRemote()
                : await state.pushRemote();
          const lines: ShellLine[] = [result.ok ? info(result.message) : err(result.message)];
          if (result.detail) lines.push(result.ok ? info(result.detail) : err(result.detail));
          for (const path of result.conflicts ?? []) lines.push(err(`  ${path}`));
          return lines;
        }
        case 'clone':
          return [
            err('git clone is not available in Forge.'),
            info(
              'Use Import from GitHub on the dashboard, or connect a repository from the Source Control panel.',
            ),
          ];
        default:
          return [err(`git: '${sub}' is not a Forge VCS command. Run "git" for the list.`)];
      }
    } catch (error) {
      return [err(`git: ${errorMessage(error)}`)];
    }
  },
}));
