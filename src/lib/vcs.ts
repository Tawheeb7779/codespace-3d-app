/**
 * Forge VCS — a snapshot version control engine that runs entirely in the
 * browser.
 *
 * It models the git concepts the IDE actually needs: a content addressed blob
 * store, commits with parents, branches, a staging index, status, diff and a
 * three-way merge. It is *not* git: it does not produce git objects and cannot
 * talk to a git remote. The UI labels it accordingly rather than pretending
 * that `push` reached a server.
 */

import { mergeThreeWay } from '@/lib/diff';

export interface Commit {
  id: string;
  message: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
  /** path -> blob hash */
  tree: Record<string, string>;
}

export interface Repo {
  /** Blob store: hash -> file content. */
  blobs: Record<string, string>;
  commits: Record<string, Commit>;
  /** branch name -> commit id */
  branches: Record<string, string>;
  head: string;
  /** Staged snapshot: path -> blob hash. */
  index: Record<string, string>;
  initialized: boolean;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
}

export interface RepoStatus {
  branch: string;
  staged: FileChange[];
  unstaged: FileChange[];
  clean: boolean;
}

/**
 * FNV-1a 64 bit (as two 32 bit halves) rendered hex. Not cryptographic — it is
 * a content key for an in-memory store, chosen because it is synchronous and
 * dependency free. Collisions would only ever mis-key a local snapshot.
 */
export function hashContent(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function emptyRepo(): Repo {
  return { blobs: {}, commits: {}, branches: {}, head: 'main', index: {}, initialized: false };
}

export function initRepo(): Repo {
  return { ...emptyRepo(), branches: { main: '' }, initialized: true };
}

export function headCommit(repo: Repo): Commit | null {
  const id = repo.branches[repo.head];
  return id ? (repo.commits[id] ?? null) : null;
}

export function headTree(repo: Repo): Record<string, string> {
  return headCommit(repo)?.tree ?? {};
}

/** Reconstruct the file map recorded by a commit. */
export function checkoutTree(repo: Repo, commitId: string): Record<string, string> {
  const commit = repo.commits[commitId];
  if (!commit) return {};
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(commit.tree)) {
    files[path] = repo.blobs[hash] ?? '';
  }
  return files;
}

function treeOf(files: Record<string, string>): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) tree[path] = hashContent(content);
  return tree;
}

function compare(from: Record<string, string>, to: Record<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of Object.keys(to)) {
    if (!(path in from)) changes.push({ path, status: 'added' });
    else if (from[path] !== to[path]) changes.push({ path, status: 'modified' });
  }
  for (const path of Object.keys(from)) {
    if (!(path in to)) changes.push({ path, status: 'deleted' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function status(repo: Repo, working: Record<string, string>): RepoStatus {
  const workTree = treeOf(working);
  const staged = compare(headTree(repo), repo.index);
  const unstaged = compare(repo.index, workTree);
  return {
    branch: repo.head,
    staged,
    unstaged,
    clean: staged.length === 0 && unstaged.length === 0,
  };
}

/** Stage specific paths (or everything when `paths` is omitted). */
export function stage(repo: Repo, working: Record<string, string>, paths?: string[]): Repo {
  const workTree = treeOf(working);
  const blobs = { ...repo.blobs };
  const index = { ...repo.index };
  const targets = paths ?? [...new Set([...Object.keys(workTree), ...Object.keys(index)])];
  for (const path of targets) {
    if (path in workTree) {
      index[path] = workTree[path];
      blobs[workTree[path]] = working[path];
    } else {
      delete index[path];
    }
  }
  return { ...repo, blobs, index };
}

export function unstage(repo: Repo, paths?: string[]): Repo {
  const head = headTree(repo);
  const index = { ...repo.index };
  const targets = paths ?? Object.keys(index);
  for (const path of targets) {
    if (path in head) index[path] = head[path];
    else delete index[path];
  }
  return { ...repo, index };
}

/** Restore working-tree files from the index (discard local edits). */
export function discard(
  repo: Repo,
  working: Record<string, string>,
  paths: string[],
): Record<string, string> {
  const next = { ...working };
  for (const path of paths) {
    const hash = repo.index[path];
    if (hash === undefined) delete next[path];
    else next[path] = repo.blobs[hash] ?? '';
  }
  return next;
}

export class VcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VcsError';
  }
}

export function commit(
  repo: Repo,
  message: string,
  author: { name: string; email: string },
): Repo {
  if (!repo.initialized) throw new VcsError('Repository is not initialized. Run "git init" first.');
  const trimmed = message.trim();
  if (!trimmed) throw new VcsError('Commit message cannot be empty');
  const parent = repo.branches[repo.head] || '';
  const changes = compare(headTree(repo), repo.index);
  if (!changes.length) throw new VcsError('Nothing staged to commit');

  const id = hashContent(
    `${parent}|${trimmed}|${Date.now()}|${Object.entries(repo.index).sort().join(',')}`,
  );
  const next: Commit = {
    id,
    message: trimmed,
    author: author.name,
    email: author.email,
    timestamp: Date.now(),
    parents: parent ? [parent] : [],
    tree: { ...repo.index },
  };
  return {
    ...repo,
    commits: { ...repo.commits, [id]: next },
    branches: { ...repo.branches, [repo.head]: id },
  };
}

/**
 * Record a complete working tree as a commit with explicit parents.
 *
 * `commit()` above always builds on the index and the current branch tip,
 * which is right for a user commit. Bringing remote history in needs the other
 * shape: a known tree, and parents that may include a commit the user never
 * made locally. Both funnel into the same commit and blob representation.
 */
export function commitFiles(
  repo: Repo,
  files: Record<string, string>,
  message: string,
  author: { name: string; email: string },
  parents: string[],
  timestamp = Date.now(),
): { repo: Repo; commit: Commit } {
  const staged = stage({ ...repo, index: {} }, files);
  const id = hashContent(`${parents.join('+')}|${message}|${timestamp}|${Object.entries(staged.index).sort().join(',')}`);
  const created: Commit = {
    id,
    message,
    author: author.name,
    email: author.email,
    timestamp,
    parents: parents.filter(Boolean),
    tree: { ...staged.index },
  };
  return {
    repo: {
      ...staged,
      commits: { ...staged.commits, [id]: created },
      branches: { ...staged.branches, [staged.head]: id },
    },
    commit: created,
  };
}

export function log(repo: Repo, branch = repo.head, limit = 200): Commit[] {
  const out: Commit[] = [];
  const seen = new Set<string>();
  const queue = [repo.branches[branch]].filter(Boolean) as string[];
  while (queue.length && out.length < limit) {
    // Walk newest-first across merge parents.
    queue.sort((a, b) => (repo.commits[b]?.timestamp ?? 0) - (repo.commits[a]?.timestamp ?? 0));
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const commitRecord = repo.commits[id];
    if (!commitRecord) continue;
    out.push(commitRecord);
    queue.push(...commitRecord.parents);
  }
  return out;
}

export function createBranch(repo: Repo, name: string): Repo {
  const clean = name.trim();
  if (!/^[\w.\-/]+$/.test(clean)) throw new VcsError(`Invalid branch name: ${name}`);
  if (repo.branches[clean] !== undefined) throw new VcsError(`Branch "${clean}" already exists`);
  return { ...repo, branches: { ...repo.branches, [clean]: repo.branches[repo.head] || '' } };
}

export function deleteBranch(repo: Repo, name: string): Repo {
  if (name === repo.head) throw new VcsError('Cannot delete the checked out branch');
  if (repo.branches[name] === undefined) throw new VcsError(`Unknown branch: ${name}`);
  const branches = { ...repo.branches };
  delete branches[name];
  return { ...repo, branches };
}

export interface CheckoutResult {
  repo: Repo;
  files: Record<string, string>;
}

/**
 * Switch branches. Uncommitted work would be lost, so the caller must have
 * already committed or discarded it — we refuse otherwise.
 */
export function checkout(
  repo: Repo,
  working: Record<string, string>,
  branch: string,
): CheckoutResult {
  if (repo.branches[branch] === undefined) throw new VcsError(`Unknown branch: ${branch}`);
  const current = status(repo, working);
  if (!current.clean) {
    throw new VcsError('You have uncommitted changes. Commit or discard them before switching.');
  }
  const target = repo.branches[branch];
  const files = target ? checkoutTree(repo, target) : {};
  return {
    repo: { ...repo, head: branch, index: target ? { ...repo.commits[target].tree } : {} },
    files,
  };
}

function ancestorSet(repo: Repo, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    if (!current || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(repo.commits[current]?.parents ?? []));
  }
  return seen;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    queue.sort((x, y) => (repo.commits[y]?.timestamp ?? 0) - (repo.commits[x]?.timestamp ?? 0));
    const current = queue.shift()!;
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfA.has(current)) return current;
    queue.push(...(repo.commits[current]?.parents ?? []));
  }
  return null;
}

export interface TreeMerge {
  files: Record<string, string>;
  /** Paths whose merge left conflict markers in the text. */
  conflicts: string[];
}

/**
 * Three-way merge of whole working trees.
 *
 * This is the single implementation of Forge's merge semantics: branch merges
 * and remote pulls both come through here, so a conflict looks and resolves
 * identically no matter where the other side came from.
 *
 * A path deleted on one side and edited on the other is a conflict git also
 * refuses to decide; Forge keeps the surviving content and names the path.
 */
export function mergeTrees(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>,
): TreeMerge {
  const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  const files: Record<string, string> = {};
  const conflicts: string[] = [];

  for (const path of paths) {
    const inBase = base[path];
    const inOurs = ours[path];
    const inTheirs = theirs[path];
    if (inOurs === undefined && inTheirs === undefined) continue;
    if (inOurs === undefined) {
      if (inBase === undefined || inBase === inTheirs) files[path] = inTheirs!;
      else {
        conflicts.push(path);
        files[path] = inTheirs!;
      }
      continue;
    }
    if (inTheirs === undefined) {
      if (inBase === undefined || inBase === inOurs) files[path] = inOurs;
      else {
        conflicts.push(path);
        files[path] = inOurs;
      }
      continue;
    }
    const result = mergeThreeWay(inBase ?? '', inOurs, inTheirs);
    files[path] = result.text;
    if (result.conflicted) conflicts.push(path);
  }

  return { files, conflicts: conflicts.sort() };
}

export interface MergeOutcome {
  repo: Repo;
  files: Record<string, string>;
  conflicts: string[];
  fastForward: boolean;
  alreadyUpToDate: boolean;
}

/** Merge `branch` into the current HEAD using per-file three-way merge. */
export function merge(
  repo: Repo,
  working: Record<string, string>,
  branch: string,
  author: { name: string; email: string },
): MergeOutcome {
  if (repo.branches[branch] === undefined) throw new VcsError(`Unknown branch: ${branch}`);
  if (branch === repo.head) throw new VcsError('Cannot merge a branch into itself');
  if (!status(repo, working).clean) {
    throw new VcsError('Commit or discard your changes before merging');
  }

  const oursId = repo.branches[repo.head];
  const theirsId = repo.branches[branch];
  if (!theirsId) throw new VcsError(`Branch "${branch}" has no commits`);
  if (!oursId) {
    const files = checkoutTree(repo, theirsId);
    return {
      repo: { ...repo, branches: { ...repo.branches, [repo.head]: theirsId }, index: { ...repo.commits[theirsId].tree } },
      files,
      conflicts: [],
      fastForward: true,
      alreadyUpToDate: false,
    };
  }

  const base = mergeBase(repo, oursId, theirsId);
  if (base === theirsId) {
    return { repo, files: working, conflicts: [], fastForward: false, alreadyUpToDate: true };
  }
  if (base === oursId) {
    const files = checkoutTree(repo, theirsId);
    return {
      repo: {
        ...repo,
        branches: { ...repo.branches, [repo.head]: theirsId },
        index: { ...repo.commits[theirsId].tree },
      },
      files,
      conflicts: [],
      fastForward: true,
      alreadyUpToDate: false,
    };
  }

  const { files: merged, conflicts } = mergeTrees(
    base ? checkoutTree(repo, base) : {},
    checkoutTree(repo, oursId),
    checkoutTree(repo, theirsId),
  );

  let nextRepo = { ...repo };
  if (!conflicts.length) {
    const staged = stage({ ...nextRepo, index: {} }, merged);
    const id = hashContent(`${oursId}|${theirsId}|merge|${Date.now()}`);
    const mergeCommit: Commit = {
      id,
      message: `Merge branch '${branch}' into ${repo.head}`,
      author: author.name,
      email: author.email,
      timestamp: Date.now(),
      parents: [oursId, theirsId],
      tree: { ...staged.index },
    };
    nextRepo = {
      ...staged,
      commits: { ...staged.commits, [id]: mergeCommit },
      branches: { ...staged.branches, [repo.head]: id },
    };
  }

  return { repo: nextRepo, files: merged, conflicts, fastForward: false, alreadyUpToDate: false };
}

/** Content of a path at HEAD, or '' when the file is new. */
export function headContent(repo: Repo, path: string): string {
  const hash = headTree(repo)[path];
  return hash ? (repo.blobs[hash] ?? '') : '';
}

export function indexContent(repo: Repo, path: string): string {
  const hash = repo.index[path];
  return hash ? (repo.blobs[hash] ?? '') : '';
}
