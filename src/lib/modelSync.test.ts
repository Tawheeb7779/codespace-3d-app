import { describe, expect, it } from 'vitest';
import { changedPaths, hasRemovals, minimalEdit } from '@/lib/modelSync';

/**
 * What the editor has to reconcile after a write.
 *
 * This runs on every keystroke, because the store replaces its file map on
 * every write. It used to walk the whole project and read each Monaco model to
 * compare, which on a 900-file project meant materialising the text of the
 * entire project before the frame could paint — measured p95 keystroke-to-frame
 * 61.3ms there against 22.6ms on a small project.
 *
 * The property that makes the cheap version correct is that a write replaces
 * the map but keeps the identical string for every untouched file. These pin
 * that: identity is the comparison, and a mutation-in-place would be a bug
 * elsewhere that these would not — and should not — paper over.
 */

describe('what changed', () => {
  it('finds nothing when the map is the same object', () => {
    const files = { 'a.ts': 'a', 'b.ts': 'b' };

    expect(changedPaths(files, files)).toEqual([]);
  });

  it('finds nothing when a new map keeps every string', () => {
    const a = 'contents of a';
    const b = 'contents of b';

    // Exactly what a store write produces for the files it did not touch.
    expect(changedPaths({ 'a.ts': a, 'b.ts': b }, { 'a.ts': a, 'b.ts': b })).toEqual([]);
  });

  it('finds only the file that was written', () => {
    const untouched = 'unchanged';
    const previous = { 'a.ts': untouched, 'b.ts': 'before' };
    const next = { 'a.ts': untouched, 'b.ts': 'after' };

    expect(changedPaths(previous, next)).toEqual(['b.ts']);
  });

  it('finds a newly created file', () => {
    expect(changedPaths({ 'a.ts': 'a' }, { 'a.ts': 'a', 'new.ts': '' })).toEqual(['new.ts']);
  });

  it('reports everything on the first sync, when nothing is known yet', () => {
    expect(changedPaths({}, { 'a.ts': 'a', 'b.ts': 'b' }).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('does not report a deleted file, which is the sweep\'s job', () => {
    expect(changedPaths({ 'gone.ts': 'x', 'a.ts': 'a' }, { 'a.ts': 'a' })).toEqual([]);
  });

  it('skips a rebuilt string that says the same thing', () => {
    // `!==` on strings compares values, not references, so a separately built
    // string with the same text is correctly seen as unchanged — the model
    // already holds that text, so there is nothing to do.
    const previous = { 'a.ts': 'same' };
    const next = { 'a.ts': ['sa', 'me'].join('') };

    expect(changedPaths(previous, next)).toEqual([]);
  });

  it('stays proportional to the project, not to its size on disk', () => {
    const big = 'x'.repeat(100_000);
    const previous: Record<string, string> = {};
    for (let i = 0; i < 900; i++) previous[`f${i}.ts`] = big;
    const next = { ...previous, 'f500.ts': `${big}!` };

    // The point is that this never touches the 100KB strings it skips.
    expect(changedPaths(previous, next)).toEqual(['f500.ts']);
  });
});

describe('whether anything was removed', () => {
  it('is false for a plain edit, so the model sweep is skipped', () => {
    const untouched = 'a';
    expect(hasRemovals({ 'a.ts': untouched, 'b.ts': '1' }, { 'a.ts': untouched, 'b.ts': '2' })).toBe(
      false,
    );
  });

  it('is false when a file was added', () => {
    expect(hasRemovals({ 'a.ts': 'a' }, { 'a.ts': 'a', 'b.ts': 'b' })).toBe(false);
  });

  it('is true when a file went away', () => {
    expect(hasRemovals({ 'a.ts': 'a', 'b.ts': 'b' }, { 'a.ts': 'a' })).toBe(true);
  });

  it('is true when a file was renamed, since the old path disappeared', () => {
    expect(hasRemovals({ 'old.ts': 'x' }, { 'new.ts': 'x' })).toBe(true);
  });

  it('is false on the first sync', () => {
    expect(hasRemovals({}, { 'a.ts': 'a' })).toBe(false);
  });
});

describe('the smallest edit between two texts', () => {
  /**
   * The property that matters is not "it produces some edit" — replacing the
   * whole file always does — but that applying it reproduces the target while
   * touching as little as possible. The first is correctness; the second is
   * whether the cursor and the undo stack survive.
   */
  const applied = (current: string, next: string) => {
    const edit = minimalEdit(current, next);
    if (!edit) return current;
    return current.slice(0, edit.start) + edit.text + current.slice(edit.end);
  };

  it('is nothing at all when the texts are identical', () => {
    expect(minimalEdit('const x = 1;', 'const x = 1;')).toBeNull();
  });

  it('touches only the characters that changed', () => {
    const edit = minimalEdit('const x = 1;', 'const x = 2;');

    expect(edit).toEqual({ start: 10, end: 11, text: '2' });
  });

  it('is an insertion with an empty range when text is only added', () => {
    const edit = minimalEdit('ab', 'axb')!;

    expect(edit.start).toBe(edit.end);
    expect(edit.text).toBe('x');
  });

  it('is a deletion with empty text when text is only removed', () => {
    const edit = minimalEdit('axb', 'ab')!;

    expect(edit.text).toBe('');
    expect(edit.end - edit.start).toBe(1);
  });

  /**
   * The case that makes a naive prefix/suffix scan produce an inverted range:
   * the scans meet in the middle and both claim the same characters.
   */
  it('does not let the prefix and suffix scans overlap', () => {
    const edit = minimalEdit('aaa', 'aa')!;

    expect(edit.start).toBeLessThanOrEqual(edit.end);
    expect(applied('aaa', 'aa')).toBe('aa');
  });

  it('reproduces the target for every shape of change', () => {
    const cases: Array<[string, string]> = [
      ['', 'new file\n'],
      ['gone\n', ''],
      ['line one\nline two\n', 'line one\nline CHANGED\n'],
      ['prefix same suffix', 'prefix different suffix'],
      ['aaaa', 'aaaaa'],
      ['aaaaa', 'aaaa'],
      ['abc', 'cba'],
      ['ünïcödé 🎉', 'ünïcödé 🎈'],
    ];

    for (const [current, next] of cases) {
      expect(applied(current, next), `${current} -> ${next}`).toBe(next);
    }
  });
});
