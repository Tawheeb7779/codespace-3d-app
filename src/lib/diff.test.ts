import { describe, expect, it } from 'vitest';
import { diffLines, diffStat, mergeThreeWay, splitLines } from '@/lib/diff';

describe('splitLines', () => {
  it('normalises CRLF and treats empty text as no lines', () => {
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('diffLines', () => {
  it('marks identical files as all equal', () => {
    const result = diffLines('a\nb', 'a\nb');
    expect(result.every((line) => line.op === 'equal')).toBe(true);
  });

  it('detects a single changed line', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc');
    expect(result.filter((l) => l.op === 'remove').map((l) => l.text)).toEqual(['b']);
    expect(result.filter((l) => l.op === 'add').map((l) => l.text)).toEqual(['B']);
  });

  it('numbers old and new lines independently', () => {
    const result = diffLines('a\nc', 'a\nb\nc');
    const added = result.find((line) => line.op === 'add');
    expect(added).toMatchObject({ text: 'b', oldLine: null, newLine: 2 });
    const last = result[result.length - 1];
    expect(last).toMatchObject({ text: 'c', oldLine: 2, newLine: 3 });
  });

  it('counts additions and deletions', () => {
    expect(diffStat('a\nb\nc', 'a\nc\nd')).toEqual({ additions: 1, deletions: 1 });
  });

  it('handles a wholesale replacement', () => {
    const result = diffLines('one\ntwo', 'three\nfour');
    expect(result.filter((l) => l.op === 'remove')).toHaveLength(2);
    expect(result.filter((l) => l.op === 'add')).toHaveLength(2);
  });
});

describe('mergeThreeWay', () => {
  const base = 'line1\nline2\nline3';

  it('returns either side when only one changed', () => {
    expect(mergeThreeWay(base, base, 'line1\nCHANGED\nline3')).toEqual({
      text: 'line1\nCHANGED\nline3',
      conflicted: false,
    });
    expect(mergeThreeWay(base, 'line1\nMINE\nline3', base).text).toBe('line1\nMINE\nline3');
  });

  it('is a no-op when both sides made the same change', () => {
    const same = 'line1\nSAME\nline3';
    expect(mergeThreeWay(base, same, same)).toEqual({ text: same, conflicted: false });
  });

  it('combines edits to different regions', () => {
    const result = mergeThreeWay(base, 'MINE\nline2\nline3', 'line1\nline2\nTHEIRS');
    expect(result.conflicted).toBe(false);
    expect(result.text).toBe('MINE\nline2\nTHEIRS');
  });

  it('emits conflict markers when both sides changed the same line', () => {
    const result = mergeThreeWay(base, 'line1\nMINE\nline3', 'line1\nTHEIRS\nline3');
    expect(result.conflicted).toBe(true);
    expect(result.text).toContain('<<<<<<< ours');
    expect(result.text).toContain('MINE');
    expect(result.text).toContain('=======');
    expect(result.text).toContain('THEIRS');
    expect(result.text).toContain('>>>>>>> theirs');
  });
});
