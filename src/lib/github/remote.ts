import type { Repo } from '@/lib/vcs';
import { checkoutTree, headTree } from '@/lib/vcs';
import { assertBranchName, assertOwner, assertRepoName } from '@/lib/github/identifiers';

/**
 * The remote-tracking half of Forge VCS.
 *
 * Forge commits are content snapshots keyed by an FNV hash; GitHub commits are
 * git objects keyed by SHA-1. Neither can be derived from the other, so the
 * link between them is recorded explicitly here: which remote commit the local
 * history is based on, and which git SHA each pushed local commit became.
 *
 * Everything in this module is a pure function over that record. Deciding
 * whether a pull can fast-forward, or whether a push would clobber someone
 * else's work, happens here and is unit-testable without a network.
 */

export interface RemoteRef {
  provider: 'github';
  owner: string;
  repo: string;
  repoId: number;
  defaultBranch: string;
  /** Remote branch this project's current work tracks. */
  branch: string;
  /** Remote tip seen by the last successful fetch. */
  lastFetchedSha: string | null;
  /** Remote tip the local history is known to contain. */
  lastSyncedSha: string | null;
  lastFetchedAt: number | null;
  /** Working tree at `lastSyncedSha`, the merge base for a divergent pull. */
  syncedTree: Record<string, string> | null;
  /**
   * Local commit the remote branch is level with, in the sense that pushing
   * everything after it produces the remote's current content plus ours.
   *
   * This is not always "the local commit whose tree equals the remote tip".
   * After a pull that merged, no local commit has the remote's tree — the
   * merge commit has *more* than it. Pointing this at the merge commit's
   * parent makes the merge commit itself the one thing left to send, which is
   * exactly right: its tree already contains both sides.
   */
  pushedUpTo: string | null;
  /**
   * A pull that hit conflicts, waiting on the user.
   *
   * git models this with MERGE_HEAD: the remote commit has been brought in,
   * but the merge is only complete once the resolution is committed. Without
   * it a resolved conflict is a dead end — the remote has moved past the last
   * synced point, so every push is refused and every pull tries to merge the
   * same commit again.
   */
  merging: { sha: string; tree: Record<string, string> } | null;
  /** Forge commit id -> git SHA, for local commits that reached the remote. */
  commitShas: Record<string, string>;
}

export function newRemoteRef(input: {
  owner: string;
  repo: string;
  repoId: number;
  defaultBranch: string;
  branch?: string;
}): RemoteRef {
  const branch = input.branch ?? input.defaultBranch;
  return {
    provider: 'github',
    owner: assertOwner(input.owner),
    repo: assertRepoName(input.repo),
    repoId: input.repoId,
    defaultBranch: assertBranchName(input.defaultBranch),
    branch: assertBranchName(branch),
    lastFetchedSha: null,
    lastSyncedSha: null,
    lastFetchedAt: null,
    syncedTree: null,
    pushedUpTo: null,
    merging: null,
    commitShas: {},
  };
}

/** Local commits from the synced point up to HEAD, oldest first. */
export function commitsToPush(repo: Repo, remote: RemoteRef): string[] {
  const head = repo.branches[repo.head];
  if (!head) return [];
  const syncedLocal = remote.pushedUpTo ?? localCommitFor(remote, remote.lastSyncedSha);
  const chain: string[] = [];
  let cursor: string | undefined = head;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (syncedLocal && cursor === syncedLocal) break;
    seen.add(cursor);
    chain.push(cursor);
    // Follow the first parent: that is the line of development this branch
    // represents, exactly as `git log --first-parent` reports it.
    cursor = repo.commits[cursor]?.parents[0];
  }
  return chain.reverse();
}

/** The local commit id that a remote SHA was recorded against, if any. */
export function localCommitFor(remote: RemoteRef, sha: string | null): string | null {
  if (!sha) return null;
  for (const [local, remoteSha] of Object.entries(remote.commitShas)) {
    if (remoteSha === sha) return local;
  }
  return null;
}

export type SyncState =
  | 'unlinked'
  | 'merging'
  | 'in-sync'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'remote-empty'
  | 'never-fetched';

export interface SyncStatus {
  state: SyncState;
  ahead: number;
  /** Remote commits not yet in local history, when a fetch has reported them. */
  behind: number;
  branch: string;
  remoteBranch: string;
  lastFetchedAt: number | null;
}

/**
 * Compare local history against what the last fetch saw.
 *
 * `behind` is supplied by the caller because only a fetch can know it — this
 * function never guesses at remote state it has not been told about.
 */
export function syncStatus(repo: Repo, remote: RemoteRef | null, behind: number): SyncStatus {
  if (!remote) {
    return {
      state: 'unlinked',
      ahead: 0,
      behind: 0,
      branch: repo.head,
      remoteBranch: '',
      lastFetchedAt: null,
    };
  }
  const ahead = commitsToPush(repo, remote).length;
  const base = {
    ahead,
    behind,
    branch: repo.head,
    remoteBranch: remote.branch,
    lastFetchedAt: remote.lastFetchedAt,
  };
  if (remote.merging) return { ...base, state: 'merging' };
  if (!remote.lastFetchedAt) return { ...base, state: 'never-fetched' };
  if (!remote.lastFetchedSha) return { ...base, state: 'remote-empty' };
  if (ahead && behind) return { ...base, state: 'diverged' };
  if (ahead) return { ...base, state: 'ahead' };
  if (behind) return { ...base, state: 'behind' };
  return { ...base, state: 'in-sync' };
}

export type PullPlan =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forward'; toSha: string }
  | { kind: 'merge'; toSha: string }
  | { kind: 'blocked'; reason: string };

/**
 * Decide what a pull should do, given the remote tip a fetch just observed.
 *
 * The rules mirror git's: nothing to do when the tip is already recorded, a
 * fast-forward when the local branch has added nothing since the last sync,
 * and a three-way merge otherwise. A dirty working tree blocks every path —
 * uncommitted work is never merged over.
 */
export function planPull(
  repo: Repo,
  remote: RemoteRef,
  remoteSha: string | null,
  workingClean: boolean,
): PullPlan {
  if (remote.merging) {
    return {
      kind: 'blocked',
      reason:
        'A merge is in progress. Resolve the conflicted files, stage them and commit to finish it.',
    };
  }
  if (!workingClean) {
    return {
      kind: 'blocked',
      reason: 'You have uncommitted changes. Commit or discard them before pulling.',
    };
  }
  if (!remoteSha) return { kind: 'up-to-date' };
  if (remoteSha === remote.lastSyncedSha) return { kind: 'up-to-date' };

  const localHead = repo.branches[repo.head] || '';
  const syncedLocal = remote.pushedUpTo ?? localCommitFor(remote, remote.lastSyncedSha);
  // Nothing committed locally since the last sync: the remote simply moved on.
  const localUnchanged = !localHead || (syncedLocal ? localHead === syncedLocal : !remote.lastSyncedSha);
  if (localUnchanged) return { kind: 'fast-forward', toSha: remoteSha };
  return { kind: 'merge', toSha: remoteSha };
}

export type PushPlan =
  | { kind: 'nothing-to-push' }
  | { kind: 'push'; commits: string[]; baseSha: string | null }
  | { kind: 'blocked'; reason: string };

/**
 * Decide whether a push may proceed against the remote tip just fetched.
 *
 * A remote tip Forge has not already incorporated means somebody else pushed;
 * sending our history would drop theirs. Forge refuses and asks for a pull —
 * it never resolves that by forcing.
 */
export function planPush(
  repo: Repo,
  remote: RemoteRef,
  remoteSha: string | null,
  workingClean: boolean,
): PushPlan {
  if (remote.merging) {
    return {
      kind: 'blocked',
      reason:
        'A merge is in progress. Resolve the conflicted files, stage them and commit before pushing.',
    };
  }
  const commits = commitsToPush(repo, remote);
  if (!commits.length) {
    return remoteSha === remote.lastSyncedSha
      ? { kind: 'nothing-to-push' }
      : { kind: 'blocked', reason: 'The remote has new commits. Pull before pushing.' };
  }
  if (!workingClean) {
    return {
      kind: 'blocked',
      reason: 'You have uncommitted changes. Commit them before pushing.',
    };
  }
  if (remoteSha !== remote.lastSyncedSha) {
    return {
      kind: 'blocked',
      reason:
        'The remote branch has moved since your last sync, so pushing would overwrite ' +
        'commits that are not in your history. Pull first, then push.',
    };
  }
  return { kind: 'push', commits, baseSha: remoteSha };
}

/**
 * Finish a conflicted merge once the resolution has been committed.
 *
 * The resolving commit's tree holds both sides, so it becomes the one thing
 * left to push, and the remote commit that caused the conflict is now recorded
 * as incorporated.
 */
export function completeMerge(remote: RemoteRef, resolvedParent: string | null): RemoteRef {
  if (!remote.merging) return remote;
  return {
    ...remote,
    lastFetchedSha: remote.merging.sha,
    lastSyncedSha: remote.merging.sha,
    syncedTree: { ...remote.merging.tree },
    pushedUpTo: resolvedParent,
    merging: null,
  };
}

/** Paths added, changed and removed between two working trees. */
export function treeDelta(
  from: Record<string, string>,
  to: Record<string, string>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, content] of Object.entries(to)) {
    if (from[path] !== content) changed.push(path);
  }
  for (const path of Object.keys(from)) {
    if (!(path in to)) removed.push(path);
  }
  return { changed: changed.sort(), removed: removed.sort() };
}

/** Working tree recorded by a local commit. */
export function treeOfCommit(repo: Repo, commitId: string): Record<string, string> {
  return checkoutTree(repo, commitId);
}

/** Working tree at the current branch tip. */
export function headFiles(repo: Repo): Record<string, string> {
  const head = repo.branches[repo.head];
  if (!head) return {};
  // `headTree` gives hashes; the working content comes from the blob store.
  const tree = headTree(repo);
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(tree)) files[path] = repo.blobs[hash] ?? '';
  return files;
}
