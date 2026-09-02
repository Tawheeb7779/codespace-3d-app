import type { GithubClient } from '@/lib/github/client';
import { GithubError } from '@/lib/github/errors';
import {
  commitsToPush,
  headFiles,
  localCommitFor,
  planPull,
  planPush,
  treeDelta,
  treeOfCommit,
  type RemoteRef,
} from '@/lib/github/remote';
import type { Commit, Repo } from '@/lib/vcs';
import { commitFiles, mergeTrees, status } from '@/lib/vcs';
import type { GithubCommitRef } from '@/lib/github/types';

/**
 * Fetch, pull and push, expressed as transformations of local state.
 *
 * Each takes the current repository and remote record and returns the next
 * ones; nothing is written to a store here. That keeps the network-facing Git
 * logic testable end to end against a GitHub API implementation without any
 * React, IndexedDB or Zustand in the way.
 *
 * The merge behaviour is not reimplemented: a divergent pull calls the same
 * `mergeTrees` a local branch merge does, so conflicts carry the same markers
 * and resolve through the same panel.
 */

export interface FetchResult {
  remote: RemoteRef;
  /** Remote tip now, or null for a branch/repository with no commits. */
  remoteSha: string | null;
  /** Commits on the remote that local history does not contain. */
  incoming: GithubCommitRef[];
  behind: number;
  /** True when the remote tip moved since the previous fetch. */
  changed: boolean;
}

export async function fetchRemote(
  client: GithubClient,
  repo: Repo,
  remote: RemoteRef,
): Promise<FetchResult> {
  const remoteSha = await client.branchTip(remote, remote.branch);
  const previous = remote.lastFetchedSha;

  let incoming: GithubCommitRef[] = [];
  let behind = 0;
  if (remoteSha && remoteSha !== remote.lastSyncedSha) {
    // Walk back from the remote tip until we reach the commit our history is
    // based on. Anything before that point we already have.
    const commits = await client.listCommits(remote, remoteSha);
    const stopAt = remote.lastSyncedSha;
    const fresh: GithubCommitRef[] = [];
    for (const commit of commits) {
      if (stopAt && commit.sha === stopAt) break;
      fresh.push(commit);
    }
    incoming = fresh;
    behind = fresh.length;
  }

  return {
    remote: { ...remote, lastFetchedSha: remoteSha, lastFetchedAt: Date.now() },
    remoteSha,
    incoming,
    behind,
    // A first fetch counts as a change so the UI stops saying "never fetched".
    changed: remoteSha !== previous,
  };
}

export type PullOutcome =
  | { kind: 'up-to-date'; remote: RemoteRef }
  | { kind: 'blocked'; reason: string; remote: RemoteRef }
  | {
      kind: 'fast-forward' | 'merged' | 'conflicts';
      remote: RemoteRef;
      repo: Repo;
      files: Record<string, string>;
      conflicts: string[];
      commit: Commit | null;
      toSha: string;
    };

export async function pullRemote(
  client: GithubClient,
  repo: Repo,
  remote: RemoteRef,
  working: Record<string, string>,
  author: { name: string; email: string },
): Promise<PullOutcome> {
  const fetched = await fetchRemote(client, repo, remote);
  const clean = !repo.initialized ? true : status(repo, working).clean;
  const plan = planPull(repo, fetched.remote, fetched.remoteSha, clean);

  if (plan.kind === 'up-to-date') return { kind: 'up-to-date', remote: fetched.remote };
  if (plan.kind === 'blocked') {
    return { kind: 'blocked', reason: plan.reason, remote: fetched.remote };
  }

  const tree = await client.readTree(fetched.remote, plan.toSha);
  const remoteFiles: Record<string, string> = {};
  for (const file of tree.files) remoteFiles[file.path] = file.content ?? '';
  if (tree.truncated) {
    return {
      kind: 'blocked',
      reason: 'That repository is too large for Forge to read in one tree.',
      remote: fetched.remote,
    };
  }

  const head = await client.commit(fetched.remote, plan.toSha);
  const message = head.message.split('\n')[0].slice(0, 200) || 'Remote commit';

  if (plan.kind === 'fast-forward') {
    const parents = [repo.branches[repo.head]].filter(Boolean) as string[];
    const { repo: next, commit } = commitFiles(repo, remoteFiles, message, author, parents);
    return {
      kind: 'fast-forward',
      remote: syncedTo(fetched.remote, plan.toSha, remoteFiles, commit.id, commit.id),
      repo: next,
      files: remoteFiles,
      conflicts: [],
      commit,
      toSha: plan.toSha,
    };
  }

  // Divergent: three-way merge against the tree we last shared with the remote.
  const base = fetched.remote.syncedTree ?? {};
  const ours = headFiles(repo);
  const merged = mergeTrees(base, ours, remoteFiles);

  if (merged.conflicts.length) {
    // Leave the conflict markers in the working tree and make no commit —
    // exactly what a conflicted `git pull` does. The remote is recorded as
    // *merging*, not synced: pushing stays blocked, and the commit that
    // resolves the conflict is what completes the merge.
    return {
      kind: 'conflicts',
      remote: {
        ...fetched.remote,
        merging: { sha: plan.toSha, tree: { ...remoteFiles } },
      },
      repo,
      files: merged.files,
      conflicts: merged.conflicts,
      commit: null,
      toSha: plan.toSha,
    };
  }

  const parents = [repo.branches[repo.head]].filter(Boolean) as string[];
  const { repo: next, commit } = commitFiles(
    repo,
    merged.files,
    `Merge ${fetched.remote.owner}/${fetched.remote.repo}@${plan.toSha.slice(0, 7)} into ${repo.head}`,
    author,
    parents,
  );
  return {
    kind: 'merged',
    // The merge base for the *next* pull is the remote tree we just took in,
    // and the merge commit is what still has to reach GitHub.
    remote: syncedTo(fetched.remote, plan.toSha, remoteFiles, parents[0] ?? null),
    repo: next,
    files: merged.files,
    conflicts: [],
    commit,
    toSha: plan.toSha,
  };
}

/**
 * Record that local history now contains everything up to `sha`.
 *
 * `pushedUpTo` is the subtle field. On a fast-forward the new local commit is
 * a faithful copy of the remote one, so it *is* the synced point. On a merge
 * it is not: the merge commit holds both sides, so the synced point stays at
 * its parent and the merge commit becomes the single thing left to push.
 */
function syncedTo(
  remote: RemoteRef,
  sha: string,
  tree: Record<string, string>,
  pushedUpTo: string | null,
  localCommitId?: string,
): RemoteRef {
  return {
    ...remote,
    lastFetchedSha: sha,
    lastSyncedSha: sha,
    syncedTree: { ...tree },
    pushedUpTo,
    commitShas: localCommitId ? { ...remote.commitShas, [localCommitId]: sha } : remote.commitShas,
  };
}

export type PushOutcome =
  | { kind: 'nothing-to-push'; remote: RemoteRef }
  | { kind: 'blocked'; reason: string; remote: RemoteRef }
  | { kind: 'pushed'; remote: RemoteRef; sha: string; commits: number; createdBranch: boolean };

/**
 * Send local commits to GitHub as real git objects.
 *
 * Each local commit becomes a git commit with the previous one as its parent,
 * so history is preserved rather than squashed. The branch pointer only moves
 * once every object exists, and it moves with `force: false` — GitHub performs
 * the fast-forward check and rejects anything else. Success is reported only
 * after GitHub has confirmed the ref update.
 */
export async function pushRemote(
  client: GithubClient,
  repo: Repo,
  remote: RemoteRef,
  working: Record<string, string>,
): Promise<PushOutcome> {
  const remoteSha = await client.branchTip(remote, remote.branch);
  const tracked = { ...remote, lastFetchedSha: remoteSha, lastFetchedAt: Date.now() };
  const clean = !repo.initialized ? true : status(repo, working).clean;
  const plan = planPush(repo, tracked, remoteSha, clean);

  if (plan.kind === 'nothing-to-push') return { kind: 'nothing-to-push', remote: tracked };
  if (plan.kind === 'blocked') return { kind: 'blocked', reason: plan.reason, remote: tracked };

  // Base tree: what the remote tip holds, or nothing for an empty branch.
  const parentSha = plan.baseSha;
  let baseTreeSha: string | null = null;
  let baseFiles: Record<string, string> = {};
  if (parentSha) {
    const head = await client.commit(tracked, parentSha);
    baseTreeSha = head.treeSha;
    baseFiles = tracked.syncedTree ?? {};
  }

  const shas: Record<string, string> = { ...tracked.commitShas };
  let lastTree = baseTreeSha;
  let previousFiles = baseFiles;
  let head = parentSha;

  for (const commitId of plan.commits) {
    const local = repo.commits[commitId];
    if (!local) continue;
    const files = treeOfCommit(repo, commitId);
    const { changed, removed } = treeDelta(previousFiles, files);

    const entries: Array<{ path: string; sha: string | null }> = [];
    for (const path of changed) entries.push({ path, sha: await client.createBlob(tracked, files[path]) });
    for (const path of removed) entries.push({ path, sha: null });

    // An empty commit still needs a tree; reuse the base when nothing changed.
    const treeSha = entries.length
      ? await client.createTree(tracked, lastTree, entries)
      : (lastTree ?? (await client.createTree(tracked, null, [])));

    const created = await client.createCommit(tracked, {
      message: local.message,
      tree: treeSha,
      parents: head ? [head] : [],
      author: { name: local.author, email: local.email },
    });

    shas[commitId] = created;
    head = created;
    lastTree = treeSha;
    previousFiles = files;
  }

  if (!head) return { kind: 'nothing-to-push', remote: tracked };

  let createdBranch = false;
  if (parentSha) {
    await client.updateBranch(tracked, tracked.branch, head);
  } else {
    await client.createBranch(tracked, tracked.branch, head);
    createdBranch = true;
  }

  return {
    kind: 'pushed',
    remote: {
      ...tracked,
      lastFetchedSha: head,
      lastSyncedSha: head,
      syncedTree: { ...previousFiles },
      pushedUpTo: plan.commits[plan.commits.length - 1] ?? tracked.pushedUpTo,
      commitShas: shas,
    },
    sha: head,
    commits: plan.commits.length,
    createdBranch,
  };
}

/**
 * Outgoing commits described for the UI, without another network round trip.
 */
export function outgoingCommits(repo: Repo, remote: RemoteRef): Commit[] {
  return commitsToPush(repo, remote)
    .map((id) => repo.commits[id])
    .filter(Boolean)
    .reverse();
}

/** Human-readable reason a push was rejected by GitHub itself. */
export function explainPushRejection(error: unknown): string {
  if (!(error instanceof GithubError)) return 'Push failed.';
  switch (error.kind) {
    case 'validation':
      return (
        'GitHub refused the update because it is not a fast-forward — the branch ' +
        'moved while you were pushing. Pull, then push again.'
      );
    case 'forbidden':
      return 'The connected GitHub account cannot push to this branch. It may be protected.';
    case 'not-found':
      return 'The repository or branch no longer exists on GitHub.';
    case 'unauthorized':
      return 'GitHub rejected the credentials. Reconnect your GitHub account and retry.';
    default:
      return error.message;
  }
}

export { localCommitFor };
