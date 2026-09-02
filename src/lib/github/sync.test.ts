// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { GithubClient } from '@/lib/github/client';
import { GithubError } from '@/lib/github/errors';
import {
  completeMerge,
  newRemoteRef,
  planPull,
  planPush,
  syncStatus,
  type RemoteRef,
} from '@/lib/github/remote';
import {
  explainPushRejection,
  fetchRemote,
  outgoingCommits,
  pullRemote,
  pushRemote,
} from '@/lib/github/sync';
import * as vcs from '@/lib/vcs';
import { FakeGithub } from '@/test/githubApi';

/**
 * End-to-end remote Git, run against a GitHub Git Data API that stores real
 * git objects (see `test/githubApi.ts`, proven byte-identical to `git` in
 * `objects.test.ts`). Nothing is stubbed at the client boundary: every test
 * here builds blobs, trees and commits over the wire and moves a ref, and the
 * fast-forward decisions are the server's.
 */

const AUTHOR = { name: 'Dev', email: 'dev@example.com' };

function repoWith(files: Record<string, string>, message = 'first'): vcs.Repo {
  let repo = vcs.initRepo();
  repo = vcs.stage(repo, files);
  return vcs.commit(repo, message, AUTHOR);
}

function commitInto(repo: vcs.Repo, files: Record<string, string>, message: string): vcs.Repo {
  const staged = vcs.stage(repo, files);
  return vcs.commit(staged, message, AUTHOR);
}

let api: FakeGithub;
let client: GithubClient;

beforeEach(() => {
  api = new FakeGithub({ login: 'octocat' });
  client = new GithubClient(api.transport);
});

function connect(name = 'demo', options = {}) {
  const repo = api.createRepo('octocat', name, options);
  return {
    repo,
    ref: newRemoteRef({ owner: 'octocat', repo: name, repoId: repo.id, defaultBranch: 'main' }),
  };
}

describe('fetch', () => {
  it('reports an empty repository rather than failing', async () => {
    const { ref } = connect();
    const result = await fetchRemote(client, vcs.emptyRepo(), ref);
    expect(result.remoteSha).toBeNull();
    expect(result.behind).toBe(0);
    expect(result.remote.lastFetchedAt).toBeGreaterThan(0);
  });

  it('sees the remote tip and counts incoming commits', async () => {
    const { repo: remoteRepo, ref } = connect();
    remoteRepo.seed('main', { 'README.md': '# demo\n' }, 'one');
    remoteRepo.seed('main', { 'README.md': '# demo\n', 'a.txt': 'a\n' }, 'two');

    const result = await fetchRemote(client, vcs.emptyRepo(), ref);
    expect(result.remoteSha).toBe(remoteRepo.refs.get('main'));
    expect(result.behind).toBe(2);
    expect(result.incoming.map((c) => c.message)).toEqual(['two', 'one']);
    expect(result.changed).toBe(true);
  });

  it('stops counting at the commit local history is based on', async () => {
    const { repo: remoteRepo, ref } = connect();
    const base = remoteRepo.seed('main', { 'a.txt': '1\n' }, 'base');
    remoteRepo.seed('main', { 'a.txt': '2\n' }, 'next');

    const result = await fetchRemote(client, vcs.emptyRepo(), { ...ref, lastSyncedSha: base });
    expect(result.behind).toBe(1);
    expect(result.incoming[0].message).toBe('next');
  });

  it('surfaces a deleted repository as a not-found error', async () => {
    const { ref } = connect();
    api.repos.delete('octocat/demo');
    await expect(fetchRemote(client, vcs.emptyRepo(), ref)).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('surfaces a rate limit with the reset time', async () => {
    const { ref } = connect();
    api.failWith = {
      status: 403,
      message: 'API rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
    };
    const error = await fetchRemote(client, vcs.emptyRepo(), ref).catch((e) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(error.kind).toBe('rate-limited');
    expect(error.retryAt).toBe(1700000000);
  });
});

describe('push', () => {
  it('creates the branch on an empty repository and reports the real SHA', async () => {
    const { repo: remoteRepo, ref } = connect();
    const local = repoWith({ 'index.html': '<h1>hi</h1>\n', 'src/main.js': 'console.log(1);\n' });

    const outcome = await pushRemote(client, local, ref, vcs.checkoutTree(local, local.branches.main));
    expect(outcome.kind).toBe('pushed');
    if (outcome.kind !== 'pushed') return;
    expect(outcome.createdBranch).toBe(true);
    expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(remoteRepo.refs.get('main')).toBe(outcome.sha);
    // The content really landed, as real git objects.
    expect(remoteRepo.filesAt(outcome.sha)).toEqual({
      'index.html': '<h1>hi</h1>\n',
      'src/main.js': 'console.log(1);\n',
    });
  });

  it('sends every local commit, preserving history rather than squashing', async () => {
    const { repo: remoteRepo, ref } = connect();
    let local = repoWith({ 'a.txt': '1\n' }, 'first');
    local = commitInto(local, { 'a.txt': '2\n' }, 'second');
    local = commitInto(local, { 'a.txt': '3\n', 'b.txt': 'b\n' }, 'third');

    const outcome = await pushRemote(client, local, ref, { 'a.txt': '3\n', 'b.txt': 'b\n' });
    expect(outcome.kind).toBe('pushed');
    if (outcome.kind !== 'pushed') return;
    expect(outcome.commits).toBe(3);

    const history = remoteRepo.history(outcome.sha, 10).map((c) => c.message);
    expect(history).toEqual(['third', 'second', 'first']);
    expect(remoteRepo.filesAt(outcome.sha)).toEqual({ 'a.txt': '3\n', 'b.txt': 'b\n' });
  });

  it('carries a deletion through to the remote tree', async () => {
    const { repo: remoteRepo, ref } = connect();
    let local = repoWith({ 'keep.txt': 'k\n', 'drop.txt': 'd\n' });
    const first = await pushRemote(client, local, ref, vcs.checkoutTree(local, local.branches.main));
    expect(first.kind).toBe('pushed');
    if (first.kind !== 'pushed') return;

    local = commitInto({ ...local, index: {} }, { 'keep.txt': 'k\n' }, 'drop a file');
    const second = await pushRemote(client, local, first.remote, { 'keep.txt': 'k\n' });
    expect(second.kind).toBe('pushed');
    if (second.kind !== 'pushed') return;
    expect(remoteRepo.filesAt(second.sha)).toEqual({ 'keep.txt': 'k\n' });
  });

  it('reports nothing to push when the branch is already there', async () => {
    const { ref } = connect();
    const local = repoWith({ 'a.txt': '1\n' });
    const first = await pushRemote(client, local, ref, { 'a.txt': '1\n' });
    if (first.kind !== 'pushed') throw new Error('setup failed');
    const again = await pushRemote(client, local, first.remote, { 'a.txt': '1\n' });
    expect(again.kind).toBe('nothing-to-push');
  });

  it('refuses to push over a remote that moved, and changes nothing', async () => {
    const { repo: remoteRepo, ref } = connect();
    const local = repoWith({ 'a.txt': '1\n' });
    const first = await pushRemote(client, local, ref, { 'a.txt': '1\n' });
    if (first.kind !== 'pushed') throw new Error('setup failed');

    // Somebody else pushes.
    const theirs = remoteRepo.seed('main', { 'a.txt': 'theirs\n' }, 'their work');
    const diverged = commitInto({ ...local, index: {} }, { 'a.txt': 'mine\n' }, 'my work');

    const outcome = await pushRemote(client, diverged, first.remote, { 'a.txt': 'mine\n' });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.reason).toMatch(/Pull first/);
    // Their commit is still the tip: nothing was overwritten.
    expect(remoteRepo.refs.get('main')).toBe(theirs);
  });

  it('refuses to push with uncommitted work', async () => {
    const { ref } = connect();
    const local = repoWith({ 'a.txt': '1\n' });
    const outcome = await pushRemote(client, local, ref, { 'a.txt': 'edited but not committed\n' });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.reason).toMatch(/uncommitted/i);
  });

  it('surfaces a permission failure without touching local history', async () => {
    const { ref } = connect('locked', { canPush: false });
    const local = repoWith({ 'a.txt': '1\n' });
    const locked = { ...ref, owner: 'octocat', repo: 'locked' };
    await expect(pushRemote(client, local, locked, { 'a.txt': '1\n' })).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(local.branches.main).toBeTruthy();
  });

  /**
   * The race a real push has to survive: our checks pass, then somebody else
   * pushes before our ref update lands. GitHub — not Forge — must be the one
   * that refuses, because only it sees the ref at the moment of the write.
   */
  it('is rejected by GitHub when the branch moves mid-push', async () => {
    const { repo: remoteRepo, ref } = connect();
    const local = repoWith({ 'a.txt': '1\n' });
    const first = await pushRemote(client, local, ref, { 'a.txt': '1\n' });
    if (first.kind !== 'pushed') throw new Error('setup failed');
    const ours = remoteRepo.refs.get('main');

    const next = commitInto({ ...local, index: {} }, { 'a.txt': '2\n' }, 'second');

    // Somebody else pushes just before our ref update is served.
    api.beforeRequest = (request) => {
      if (request.method === 'PATCH') {
        api.beforeRequest = null;
        remoteRepo.seed('main', { 'a.txt': 'theirs\n' }, 'theirs');
      }
    };

    await expect(pushRemote(client, next, first.remote, { 'a.txt': '2\n' })).rejects.toMatchObject({
      kind: 'validation',
    });
    // Their commit survived; ours did not silently replace it.
    expect(remoteRepo.refs.get('main')).not.toBe(ours);
    expect(remoteRepo.filesAt(remoteRepo.refs.get('main')!)['a.txt']).toBe('theirs\n');
  });

  it('explains a rejected push in terms a developer can act on', async () => {
    const { ref } = connect();
    const local = repoWith({ 'a.txt': '1\n' });
    const first = await pushRemote(client, local, ref, { 'a.txt': '1\n' });
    if (first.kind !== 'pushed') throw new Error('setup failed');
    const error = new GithubError('validation', 'Update is not a fast forward');
    expect(explainPushRejection(error)).toMatch(/fast-forward/);
    expect(explainPushRejection(error)).toMatch(/Pull, then push again/);
  });
});

describe('pull', () => {
  it('fast-forwards into an empty local repository', async () => {
    const { repo: remoteRepo, ref } = connect();
    const sha = remoteRepo.seed('main', { 'README.md': '# hello\n' }, 'initial');

    const outcome = await pullRemote(client, vcs.initRepo(), ref, {}, AUTHOR);
    expect(outcome.kind).toBe('fast-forward');
    if (outcome.kind !== 'fast-forward') return;
    expect(outcome.files).toEqual({ 'README.md': '# hello\n' });
    expect(outcome.remote.lastSyncedSha).toBe(sha);
    expect(vcs.log(outcome.repo)[0].message).toBe('initial');
  });

  it('reports up to date when the tip is already recorded', async () => {
    const { repo: remoteRepo, ref } = connect();
    const sha = remoteRepo.seed('main', { 'a.txt': '1\n' });
    const outcome = await pullRemote(
      client,
      vcs.initRepo(),
      { ...ref, lastSyncedSha: sha, syncedTree: { 'a.txt': '1\n' } },
      {},
      AUTHOR,
    );
    expect(outcome.kind).toBe('up-to-date');
  });

  it('merges divergent histories that touch different files', async () => {
    const { repo: remoteRepo, ref } = connect();
    const base = remoteRepo.seed('main', { 'a.txt': 'a\n' }, 'base');

    let local = repoWith({ 'a.txt': 'a\n' }, 'base');
    const linked: RemoteRef = {
      ...ref,
      lastSyncedSha: base,
      lastFetchedSha: base,
      syncedTree: { 'a.txt': 'a\n' },
      commitShas: { [local.branches.main]: base },
    };
    local = commitInto(local, { 'a.txt': 'a\n', 'mine.txt': 'mine\n' }, 'mine');
    remoteRepo.seed('main', { 'a.txt': 'a\n', 'theirs.txt': 'theirs\n' }, 'theirs');

    const outcome = await pullRemote(client, local, linked, {
      'a.txt': 'a\n',
      'mine.txt': 'mine\n',
    }, AUTHOR);
    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.files).toEqual({
      'a.txt': 'a\n',
      'mine.txt': 'mine\n',
      'theirs.txt': 'theirs\n',
    });
  });

  it('writes conflict markers and makes no commit when both sides edit a line', async () => {
    const { repo: remoteRepo, ref } = connect();
    const base = remoteRepo.seed('main', { 'a.txt': 'original\n' }, 'base');

    let local = repoWith({ 'a.txt': 'original\n' }, 'base');
    const linked: RemoteRef = {
      ...ref,
      lastSyncedSha: base,
      lastFetchedSha: base,
      syncedTree: { 'a.txt': 'original\n' },
      commitShas: { [local.branches.main]: base },
    };
    const before = local.branches.main;
    local = commitInto(local, { 'a.txt': 'mine\n' }, 'mine');
    remoteRepo.seed('main', { 'a.txt': 'theirs\n' }, 'theirs');

    const outcome = await pullRemote(client, local, linked, { 'a.txt': 'mine\n' }, AUTHOR);
    expect(outcome.kind).toBe('conflicts');
    if (outcome.kind !== 'conflicts') return;
    expect(outcome.conflicts).toEqual(['a.txt']);
    expect(outcome.files['a.txt']).toContain('<<<<<<<');
    expect(outcome.files['a.txt']).toContain('>>>>>>>');
    expect(outcome.commit).toBeNull();
    // No commit was made, and the remote is not marked synced, so a push
    // stays blocked until the conflict is resolved.
    expect(outcome.repo.branches.main).not.toBe(before);
    expect(outcome.remote.lastSyncedSha).toBe(base);
  });

  /**
   * The conflict path is only useful if it has an exit. Resolving and
   * committing has to complete the merge, or the remote stays ahead of the
   * last synced point forever and every later push is refused.
   */
  it('completes the merge once the resolution is committed, and then pushes', async () => {
    const { repo: remoteRepo, ref } = connect();
    const base = remoteRepo.seed('main', { 'a.txt': 'original\n' }, 'base');

    let local = repoWith({ 'a.txt': 'original\n' }, 'base');
    const linked: RemoteRef = {
      ...ref,
      lastSyncedSha: base,
      lastFetchedSha: base,
      syncedTree: { 'a.txt': 'original\n' },
      pushedUpTo: local.branches.main,
      commitShas: { [local.branches.main]: base },
    };
    local = commitInto(local, { 'a.txt': 'mine\n' }, 'mine');
    const theirs = remoteRepo.seed('main', { 'a.txt': 'theirs\n' }, 'theirs');

    const pulled = await pullRemote(client, local, linked, { 'a.txt': 'mine\n' }, AUTHOR);
    if (pulled.kind !== 'conflicts') throw new Error('expected a conflict');
    expect(pulled.remote.merging?.sha).toBe(theirs);
    expect(syncStatus(local, pulled.remote, 1).state).toBe('merging');

    // While merging, both directions are refused rather than guessed at.
    expect(planPull(local, pulled.remote, theirs, true).kind).toBe('blocked');
    expect(planPush(local, pulled.remote, theirs, true).kind).toBe('blocked');

    // The user resolves and commits.
    const parent = local.branches.main;
    const resolved = commitInto({ ...local, index: {} }, { 'a.txt': 'resolved\n' }, 'resolve');
    const finished = completeMerge(pulled.remote, parent);
    expect(finished.merging).toBeNull();
    expect(finished.lastSyncedSha).toBe(theirs);

    // And the resolution is exactly what goes to GitHub, as a fast-forward.
    const pushed = await pushRemote(client, resolved, finished, { 'a.txt': 'resolved\n' });
    expect(pushed.kind).toBe('pushed');
    if (pushed.kind !== 'pushed') return;
    expect(remoteRepo.filesAt(pushed.sha)).toEqual({ 'a.txt': 'resolved\n' });
    expect(remoteRepo.refs.get('main')).toBe(pushed.sha);
    expect(syncStatus(resolved, pushed.remote, 0).state).toBe('in-sync');
  });

  it('refuses to pull over uncommitted work', async () => {
    const { repo: remoteRepo, ref } = connect();
    remoteRepo.seed('main', { 'a.txt': '1\n' });
    const local = repoWith({ 'a.txt': '1\n' });
    const outcome = await pullRemote(client, local, ref, { 'a.txt': 'dirty\n' }, AUTHOR);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.reason).toMatch(/uncommitted/i);
  });

  it('does nothing when the branch does not exist yet', async () => {
    const { ref } = connect();
    const outcome = await pullRemote(client, vcs.initRepo(), ref, {}, AUTHOR);
    expect(outcome.kind).toBe('up-to-date');
  });
});

describe('a full round trip', () => {
  it('pushes, takes a remote change, pulls it, and pushes again', async () => {
    const { repo: remoteRepo, ref } = connect();

    // 1. First push creates the branch.
    let local = repoWith({ 'app.js': 'const a = 1;\n' }, 'initial');
    const pushed = await pushRemote(client, local, ref, { 'app.js': 'const a = 1;\n' });
    if (pushed.kind !== 'pushed') throw new Error('first push failed');
    let remote = pushed.remote;
    expect(remoteRepo.filesAt(pushed.sha)['app.js']).toBe('const a = 1;\n');

    // 2. Somebody edits a different file on GitHub.
    remoteRepo.seed('main', { 'app.js': 'const a = 1;\n', 'docs.md': '# docs\n' }, 'add docs');

    // 3. Fetch sees it.
    const fetched = await fetchRemote(client, local, remote);
    expect(fetched.behind).toBe(1);
    remote = fetched.remote;

    // 4. We commit locally too, so the histories diverge.
    local = commitInto({ ...local, index: {} }, { 'app.js': 'const a = 2;\n' }, 'bump');
    expect(outgoingCommits(local, remote).map((c) => c.message)).toEqual(['bump']);

    // 5. Pull merges both sides.
    const pulled = await pullRemote(client, local, remote, { 'app.js': 'const a = 2;\n' }, AUTHOR);
    expect(pulled.kind).toBe('merged');
    if (pulled.kind !== 'merged') throw new Error('pull did not merge');
    expect(pulled.files).toEqual({ 'app.js': 'const a = 2;\n', 'docs.md': '# docs\n' });
    local = pulled.repo;
    remote = pulled.remote;

    // 6. The merge is now pushable, and GitHub accepts it as a fast-forward.
    const second = await pushRemote(client, local, remote, pulled.files);
    expect(second.kind).toBe('pushed');
    if (second.kind !== 'pushed') return;
    expect(remoteRepo.refs.get('main')).toBe(second.sha);
    expect(remoteRepo.filesAt(second.sha)).toEqual({
      'app.js': 'const a = 2;\n',
      'docs.md': '# docs\n',
    });

    // 7. And nothing is left outstanding.
    const after = await fetchRemote(client, local, second.remote);
    expect(after.behind).toBe(0);
    expect(syncStatus(local, second.remote, 0).state).toBe('in-sync');
  });

  it('pushes a new branch without disturbing the default one', async () => {
    const { repo: remoteRepo, ref } = connect();
    const main = remoteRepo.seed('main', { 'a.txt': 'main\n' }, 'main work');

    let local = repoWith({ 'a.txt': 'main\n' }, 'main work');
    const linked: RemoteRef = {
      ...ref,
      branch: 'feature',
      lastSyncedSha: null,
      syncedTree: null,
      commitShas: {},
    };
    local = commitInto(local, { 'a.txt': 'main\n', 'f.txt': 'feature\n' }, 'feature work');

    const pushed = await pushRemote(client, local, linked, {
      'a.txt': 'main\n',
      'f.txt': 'feature\n',
    });
    expect(pushed.kind).toBe('pushed');
    if (pushed.kind !== 'pushed') return;
    expect(pushed.createdBranch).toBe(true);
    expect(remoteRepo.refs.get('feature')).toBe(pushed.sha);
    expect(remoteRepo.refs.get('main')).toBe(main);
  });
});

describe('planning', () => {
  it('describes an unlinked project', () => {
    expect(syncStatus(vcs.initRepo(), null, 0).state).toBe('unlinked');
  });

  it('counts ahead from the last synced commit', () => {
    let local = repoWith({ 'a.txt': '1\n' }, 'one');
    const first = local.branches.main;
    local = commitInto(local, { 'a.txt': '2\n' }, 'two');
    local = commitInto(local, { 'a.txt': '3\n' }, 'three');
    const remote: RemoteRef = {
      ...newRemoteRef({ owner: 'o', repo: 'r', repoId: 1, defaultBranch: 'main' }),
      lastSyncedSha: 'a'.repeat(40),
      lastFetchedSha: 'a'.repeat(40),
      lastFetchedAt: Date.now(),
      commitShas: { [first]: 'a'.repeat(40) },
    };
    expect(syncStatus(local, remote, 0)).toMatchObject({ state: 'ahead', ahead: 2 });
    expect(syncStatus(local, remote, 3)).toMatchObject({ state: 'diverged', ahead: 2, behind: 3 });
  });

  it('blocks both directions while the tree is dirty', () => {
    const local = repoWith({ 'a.txt': '1\n' });
    const remote = newRemoteRef({ owner: 'o', repo: 'r', repoId: 1, defaultBranch: 'main' });
    expect(planPull(local, remote, 'b'.repeat(40), false).kind).toBe('blocked');
    expect(planPush(local, remote, null, false).kind).toBe('blocked');
  });
});
