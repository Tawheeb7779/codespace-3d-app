import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMMIT_QUERY,
  commitFiles,
  compareBranches,
  compareCommits,
  createBranch,
  fileHistory,
  initRepo,
  log,
  searchCommits,
  type Repo,
} from '@/lib/vcs';
import { unifiedDiff } from '@/lib/diff';

/**
 * History views computed from the stored trees.
 *
 * The property worth protecting is that none of this is invented: a file's
 * history lists only the commits that actually changed it, and a comparison
 * reports the files that actually differ. Both compare blob hashes, so the
 * cases that could go wrong are the ones where a hash is absent — a file added
 * in one tree, deleted in the other, or a root commit with no parent at all.
 */

const ada = { name: 'Ada', email: 'ada@test.dev' };
const bob = { name: 'Bob', email: 'bob@test.dev' };

function commit(
  repo: Repo,
  files: Record<string, string>,
  message: string,
  author = ada,
  timestamp?: number,
) {
  return commitFiles(
    repo,
    files,
    message,
    author,
    [repo.branches[repo.head]].filter(Boolean),
    timestamp,
  );
}

describe('fileHistory', () => {
  it('lists only the commits that changed the file', () => {
    let repo = commit(initRepo(), { 'a.ts': '1', 'b.ts': 'x' }, 'first').repo;
    repo = commit(repo, { 'a.ts': '2', 'b.ts': 'x' }, 'touch a').repo;
    repo = commit(repo, { 'a.ts': '2', 'b.ts': 'y' }, 'touch b').repo;

    const history = fileHistory(repo, 'a.ts');
    expect(history.map((entry) => entry.commit.message)).toEqual(['touch a', 'first']);
    expect(history.map((entry) => entry.status)).toEqual(['modified', 'added']);
  });

  it('records a deletion, and stops there for a file that is gone', () => {
    let repo = commit(initRepo(), { 'a.ts': '1', 'b.ts': 'x' }, 'first').repo;
    repo = commit(repo, { 'a.ts': '1' }, 'drop b').repo;

    const history = fileHistory(repo, 'b.ts');
    expect(history.map((entry) => entry.status)).toEqual(['deleted', 'added']);
  });

  it('returns nothing for a path the repository has never seen', () => {
    const repo = commit(initRepo(), { 'a.ts': '1' }, 'first').repo;
    expect(fileHistory(repo, 'never.ts')).toEqual([]);
  });

  it('is empty on a repository with no commits', () => {
    expect(fileHistory(initRepo(), 'a.ts')).toEqual([]);
  });
});

describe('compareCommits', () => {
  it('reports added, modified and deleted files with real line counts', () => {
    const first = commit(initRepo(), { 'keep.ts': 'one\ntwo', 'gone.ts': 'x' }, 'first');
    const second = commit(
      first.repo,
      { 'keep.ts': 'one\ntwo\nthree', 'new.ts': 'fresh' },
      'second',
    );

    const result = compareCommits(second.repo, first.commit.id, second.commit.id)!;
    expect(result.changes).toEqual([
      { path: 'gone.ts', status: 'deleted' },
      { path: 'keep.ts', status: 'modified' },
      { path: 'new.ts', status: 'added' },
    ]);
    expect(result.additions).toBe(2); // one line in keep.ts, one as new.ts
    expect(result.deletions).toBe(1); // gone.ts
  });

  it('reports nothing between a commit and itself', () => {
    const only = commit(initRepo(), { 'a.ts': '1' }, 'first');
    const result = compareCommits(only.repo, only.commit.id, only.commit.id)!;
    expect(result.changes).toEqual([]);
    expect(result.additions + result.deletions).toBe(0);
  });

  it('returns null rather than guessing when a commit is unknown', () => {
    const only = commit(initRepo(), { 'a.ts': '1' }, 'first');
    expect(compareCommits(only.repo, 'nope', only.commit.id)).toBeNull();
    expect(compareCommits(only.repo, only.commit.id, 'nope')).toBeNull();
  });
});

describe('compareBranches', () => {
  it('compares two branch tips', () => {
    const base = commit(initRepo(), { 'a.ts': 'one' }, 'first').repo;
    const branched = { ...createBranch(base, 'feature'), head: 'feature' };
    const ahead = commit(branched, { 'a.ts': 'one', 'b.ts': 'two' }, 'on feature').repo;

    const result = compareBranches(ahead, 'main', 'feature')!;
    expect(result.changes).toEqual([{ path: 'b.ts', status: 'added' }]);
  });

  it('returns null when a branch has no commits', () => {
    const repo = createBranch(commit(initRepo(), { 'a.ts': '1' }, 'first').repo, 'empty');
    expect(compareBranches(repo, 'main', 'missing')).toBeNull();
  });
});

describe('searchCommits', () => {
  const build = () => {
    let repo = commit(initRepo(), { 'a.ts': '1' }, 'add parser', ada, 1_000).repo;
    repo = commit(repo, { 'a.ts': '2' }, 'fix parser bug', bob, 5_000).repo;
    repo = commit(repo, { 'a.ts': '3' }, 'docs', ada, 9_000).repo;
    return log(repo);
  };

  it('returns everything with an empty query', () => {
    expect(searchCommits(build(), EMPTY_COMMIT_QUERY)).toHaveLength(3);
  });

  it('matches the message, case-insensitively', () => {
    const found = searchCommits(build(), { ...EMPTY_COMMIT_QUERY, text: 'PARSER' });
    expect(found.map((c) => c.message).sort()).toEqual(['add parser', 'fix parser bug']);
  });

  it('matches a commit id prefix, which is how people paste one', () => {
    const commits = build();
    const prefix = commits[0].id.slice(0, 7);
    expect(searchCommits(commits, { ...EMPTY_COMMIT_QUERY, text: prefix })).toHaveLength(1);
  });

  it('filters by author', () => {
    const found = searchCommits(build(), { ...EMPTY_COMMIT_QUERY, author: 'bob' });
    expect(found.map((c) => c.message)).toEqual(['fix parser bug']);
  });

  it('filters by an inclusive date range', () => {
    const commits = build();
    expect(searchCommits(commits, { ...EMPTY_COMMIT_QUERY, since: 5_000 })).toHaveLength(2);
    expect(searchCommits(commits, { ...EMPTY_COMMIT_QUERY, until: 5_000 })).toHaveLength(2);
    expect(
      searchCommits(commits, { ...EMPTY_COMMIT_QUERY, since: 5_000, until: 5_000 }),
    ).toHaveLength(1);
  });

  it('combines filters', () => {
    expect(
      searchCommits(build(), { ...EMPTY_COMMIT_QUERY, text: 'parser', author: 'ada' }),
    ).toHaveLength(1);
  });
});

describe('unifiedDiff', () => {
  it('produces a patch a reviewer would recognise', () => {
    const patch = unifiedDiff('src/a.ts', 'one\ntwo\nthree', 'one\nTWO\nthree');
    expect(patch).toContain('--- a/src/a.ts');
    expect(patch).toContain('+++ b/src/a.ts');
    expect(patch).toContain('-two');
    expect(patch).toContain('+TWO');
    expect(patch).toContain(' one');
  });

  it('says nothing about an unchanged file', () => {
    expect(unifiedDiff('src/a.ts', 'same', 'same')).toBe('');
  });

  /** The property that keeps a one-line change from shipping a whole file. */
  it('includes only lines near a change', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 100', 'line one hundred');
    const patch = unifiedDiff('big.ts', before, after);
    expect(patch.split('\n').length).toBeLessThan(15);
    expect(patch).toContain('+line one hundred');
  });

  it('handles a file that is entirely new or entirely removed', () => {
    expect(unifiedDiff('new.ts', '', 'hello')).toContain('+hello');
    expect(unifiedDiff('gone.ts', 'hello', '')).toContain('-hello');
  });
});
