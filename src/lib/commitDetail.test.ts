import { describe, expect, it } from 'vitest';
import { commitContent, commitDetail, commitFiles, initRepo, type Repo } from '@/lib/vcs';

/**
 * What a commit actually changed.
 *
 * A history view that invents its numbers is worse than none, so this is
 * derived from the stored trees rather than from anything the UI remembers.
 * The cases that matter are the ones where a naive diff is wrong: a root
 * commit with no parent, a file added or deleted rather than edited, and a
 * merge, which git describes against its first parent only.
 */

const author = { name: 'Ada', email: 'ada@test.dev' };

/** Commit onto the current head, the way the app does. */
function commit(repo: Repo, files: Record<string, string>, message: string) {
  return commitFiles(repo, files, message, author, [repo.branches[repo.head]].filter(Boolean));
}

// No trailing newlines here, so a line count is exactly the visible lines.
// (`splitLines` treats a trailing newline as a final empty line, which is what
// the diff viewer shows too — covered separately below.)
function build() {
  const first = commit(initRepo(), { 'a.ts': 'one\ntwo' }, 'first').repo;
  const second = commit(first, { 'a.ts': 'one\ntwo\nthree', 'b.ts': 'new' }, 'second').repo;
  const third = commit(second, { 'a.ts': 'one\ntwo\nthree' }, 'third').repo;
  return { first, second, third };
}

const head = (repo: Repo) => repo.branches[repo.head];

describe('commitDetail', () => {
  it('treats a root commit as adding everything it contains', () => {
    const { first } = build();
    const detail = commitDetail(first, head(first))!;
    expect(detail.parent).toBeNull();
    expect(detail.changes).toEqual([{ path: 'a.ts', status: 'added' }]);
    expect(detail.additions).toBe(2);
    expect(detail.deletions).toBe(0);
  });

  it('separates an edit from an addition', () => {
    const { second } = build();
    const detail = commitDetail(second, head(second))!;
    expect(detail.changes).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
    ]);
    // One line added to a.ts, one line added as b.ts.
    expect(detail.additions).toBe(2);
    expect(detail.deletions).toBe(0);
  });

  it('reports a deletion, and counts its lines as removed', () => {
    const { third } = build();
    const detail = commitDetail(third, head(third))!;
    expect(detail.changes).toEqual([{ path: 'b.ts', status: 'deleted' }]);
    expect(detail.additions).toBe(0);
    expect(detail.deletions).toBe(1);
  });

  /** A trailing newline is a final empty line — the same thing the diff shows. */
  it('counts a trailing newline the way the diff viewer displays it', () => {
    const repo = commit(initRepo(), { 'a.ts': 'one\ntwo\n' }, 'first').repo;
    expect(commitDetail(repo, head(repo))!.additions).toBe(3);
  });

  it('lists nothing for a commit that changed nothing', () => {
    const first = commit(initRepo(), { 'a.ts': 'x\n' }, 'first').repo;
    const same = commit(first, { 'a.ts': 'x\n' }, 'no-op').repo;
    const detail = commitDetail(same, head(same))!;
    expect(detail.changes).toEqual([]);
    expect(detail.additions + detail.deletions).toBe(0);
  });

  it('returns nothing for a commit that does not exist', () => {
    const { first } = build();
    expect(commitDetail(first, 'nope')).toBeNull();
  });

  it('sorts changed paths, so the list is stable between renders', () => {
    const repo = commit(initRepo(), { 'z.ts': '1\n', 'a.ts': '1\n', 'm.ts': '1\n' }, 'many').repo;
    const detail = commitDetail(repo, head(repo))!;
    expect(detail.changes.map((change) => change.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});

describe('commitContent', () => {
  it('returns the content as of that commit, not as of now', () => {
    const { first, second } = build();
    const firstId = head(first);
    expect(commitContent(second, second.commits[firstId], 'a.ts')).toBe('one\ntwo');
    expect(commitContent(second, second.commits[head(second)], 'a.ts')).toBe('one\ntwo\nthree');
  });

  it('returns empty for a path the commit did not contain', () => {
    const { first } = build();
    expect(commitContent(first, first.commits[head(first)], 'b.ts')).toBe('');
    expect(commitContent(first, null, 'a.ts')).toBe('');
  });
});
