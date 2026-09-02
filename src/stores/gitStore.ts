import { create } from 'zustand';
import * as vcs from '@/lib/vcs';
import type { Commit, Repo, RepoStatus } from '@/lib/vcs';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { useFileStore } from '@/stores/fileStore';
import { errorMessage } from '@/lib/utils';
import type { ShellLine } from '@/lib/shell';

/**
 * Version control state.
 *
 * Backed by Forge VCS (see `lib/vcs.ts`) — real commits, branches, diffs and
 * merges held in the project's own storage. Network operations (push, pull,
 * clone from a git remote) are not implemented: they need a git smart-HTTP
 * client and credentials the browser should not hold. The UI marks them
 * unavailable and points at ZIP export / GitHub import instead.
 */

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

export const useGitStore = create<GitState>()((set, get) => ({
  repo: vcs.emptyRepo(),
  status: EMPTY_STATUS,
  history: [],
  loading: false,
  error: null,
  selectedPath: null,
  diffAgainst: 'head',

  async load(projectId) {
    set({ loading: true, error: null });
    try {
      const stored = await repositoryFor(useAuthStore.getState().user?.provider).loadVcs(projectId);
      const repo = stored ?? vcs.emptyRepo();
      set({
        repo,
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
    const repo = vcs.initRepo();
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
    const repo = vcs.commit(get().repo, message, author());
    const created = vcs.log(repo)[0];
    set({ repo, status: vcs.status(repo, useFileStore.getState().files), history: vcs.log(repo) });
    await persist(repo);
    return created;
  },

  async createBranch(name, checkoutAfter = true) {
    let repo = vcs.createBranch(get().repo, name);
    if (checkoutAfter) repo = { ...repo, head: name.trim() };
    set({ repo, status: vcs.status(repo, useFileStore.getState().files), history: vcs.log(repo) });
    await persist(repo);
  },

  async deleteBranch(name) {
    const repo = vcs.deleteBranch(get().repo, name);
    set({ repo });
    await persist(repo);
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
        info('Network operations (push/pull/clone) are not available — see the Source Control panel.'),
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
        case 'push':
        case 'pull':
        case 'clone':
        case 'fetch':
          return [
            err(`git ${sub} is not available in Forge.`),
            info(
              'Forge VCS is local to this browser. Use Export ZIP to move work out, or Import from GitHub to bring a public repository in.',
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
