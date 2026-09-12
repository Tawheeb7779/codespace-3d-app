import { beforeEach, describe, expect, it } from 'vitest';
import { buildTree, buildTreeCached, resetTreeCache, treeSignature } from '@/lib/vfs';

/**
 * The key that decides whether the file tree is rebuilt.
 *
 * `buildTree` reads `Object.keys(files)` and never a file's contents, so the
 * tree depends only on which paths exist. The store replaces the whole `files`
 * object on every write, so a memo keyed on `files` rebuilt the entire tree on
 * every keystroke — 24.6ms for a 5,000-file project, a dropped frame per
 * character typed.
 *
 * Keying on this signature is only safe if it satisfies both directions, which
 * is what the tests below assert:
 *
 *   * it must **not** change when only a file's contents change, or the
 *     optimisation does nothing;
 *   * it **must** change whenever the tree's shape changes, or the explorer
 *     shows a tree that no longer matches the project — which would be a
 *     correctness bug traded for speed, and far worse than the slow rebuild.
 */

const files = {
  'src/App.tsx': 'export const App = () => null;\n',
  'src/lib/helper.ts': 'export const helper = 1;\n',
};
const dirs = ['src', 'src/lib'];

describe('what must not change the signature', () => {
  /** The whole point: typing must not rebuild the tree. */
  it('is unchanged when a file’s contents change', () => {
    const before = treeSignature(files, dirs);
    const after = treeSignature({ ...files, 'src/App.tsx': 'edited\n' }, dirs);

    expect(after).toBe(before);
  });

  it('is unchanged when every file’s contents change', () => {
    const rewritten = Object.fromEntries(Object.keys(files).map((path) => [path, 'x']));

    expect(treeSignature(rewritten, dirs)).toBe(treeSignature(files, dirs));
  });

  it('is unchanged for a fresh object with the same paths', () => {
    expect(treeSignature({ ...files }, [...dirs])).toBe(treeSignature(files, dirs));
  });
});

describe('what must change the signature', () => {
  it.each([
    ['a file is added', { ...files, 'src/New.tsx': 'x' }, dirs],
    ['a file is removed', { 'src/App.tsx': files['src/App.tsx'] }, dirs],
    ['a directory is added', files, [...dirs, 'src/new']],
    ['a directory is removed', files, ['src']],
  ])('changes when %s', (_label, nextFiles, nextDirs) => {
    expect(treeSignature(nextFiles, nextDirs)).not.toBe(treeSignature(files, dirs));
  });

  /** A rename keeps the count identical, which is why length is not a key. */
  it('changes when a file is renamed', () => {
    const renamed = { 'src/Renamed.tsx': files['src/App.tsx'], 'src/lib/helper.ts': files['src/lib/helper.ts'] };

    expect(Object.keys(renamed)).toHaveLength(Object.keys(files).length);
    expect(treeSignature(renamed, dirs)).not.toBe(treeSignature(files, dirs));
  });

  /** Two different path sets must never collide on one signature. */
  it('distinguishes paths that could run together', () => {
    const a = treeSignature({ 'a/b': 'x', 'c': 'x' }, []);
    const b = treeSignature({ 'a': 'x', 'b/c': 'x' }, []);

    expect(a).not.toBe(b);
  });

  it('distinguishes a path from a directory of the same name', () => {
    expect(treeSignature({ 'src/a': 'x' }, [])).not.toBe(treeSignature({}, ['src/a']));
  });
});

describe('the signature agrees with the tree it keys', () => {
  /**
   * The property that makes this substitution sound: equal signature implies
   * equal tree. Asserted over a set of mutations rather than argued for.
   */
  it.each([
    ['contents changed', { ...files, 'src/App.tsx': 'different\n' }, dirs],
    ['same paths, new object', { ...files }, [...dirs]],
  ])('produces an identical tree when the signature matches (%s)', (_label, nextFiles, nextDirs) => {
    expect(treeSignature(nextFiles, nextDirs)).toBe(treeSignature(files, dirs));
    expect(buildTree(nextFiles, nextDirs)).toEqual(buildTree(files, dirs));
  });

  it('produces a different tree whenever the signature differs', () => {
    const added = { ...files, 'src/New.tsx': 'x' };

    expect(treeSignature(added, dirs)).not.toBe(treeSignature(files, dirs));
    expect(buildTree(added, dirs)).not.toEqual(buildTree(files, dirs));
  });

  it('handles an empty project', () => {
    expect(treeSignature({}, [])).toBe(treeSignature({}, []));
    expect(buildTree({}, [])).toEqual([]);
  });
});

describe('the cached tree', () => {
  beforeEach(() => resetTreeCache());

  /** The optimisation itself: identical input must not rebuild. */
  it('returns the same reference when only contents changed', () => {
    const first = buildTreeCached(files, dirs);
    const second = buildTreeCached({ ...files, 'src/App.tsx': 'edited\n' }, dirs);

    expect(second).toBe(first);
  });

  /** A stable reference is what keeps a caller's downstream memos stable. */
  it('returns the same reference for a fresh object with the same paths', () => {
    const first = buildTreeCached(files, dirs);

    expect(buildTreeCached({ ...files }, [...dirs])).toBe(first);
  });

  it('rebuilds when a path is added', () => {
    const first = buildTreeCached(files, dirs);
    const second = buildTreeCached({ ...files, 'src/New.tsx': 'x' }, dirs);

    expect(second).not.toBe(first);
    expect(second).toEqual(buildTree({ ...files, 'src/New.tsx': 'x' }, dirs));
  });

  it('rebuilds when a path is removed', () => {
    const first = buildTreeCached(files, dirs);
    const fewer = { 'src/App.tsx': files['src/App.tsx'] };

    expect(buildTreeCached(fewer, dirs)).not.toBe(first);
  });

  /** A cache hit must never return a tree that differs from a fresh build. */
  it('never returns a stale tree', () => {
    buildTreeCached(files, dirs);
    const mutations: Array<[Record<string, string>, string[]]> = [
      [{ ...files, 'src/New.tsx': 'x' }, dirs],
      [files, [...dirs, 'src/extra']],
      [{ 'src/Renamed.tsx': 'x', 'src/lib/helper.ts': 'x' }, dirs],
      [{}, []],
      [files, dirs],
    ];

    for (const [nextFiles, nextDirs] of mutations) {
      expect(buildTreeCached(nextFiles, nextDirs)).toEqual(buildTree(nextFiles, nextDirs));
    }
  });

  it('rebuilds after the cache is reset', () => {
    const first = buildTreeCached(files, dirs);
    resetTreeCache();

    expect(buildTreeCached(files, dirs)).not.toBe(first);
  });
});
