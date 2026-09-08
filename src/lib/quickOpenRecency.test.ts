import { describe, expect, it } from 'vitest';
import { rankPaths } from '@/lib/search';

/**
 * The order quick open offers files in.
 *
 * With no query, the honest answer to "which file do you want" is the one you
 * were just in — otherwise the list is an arbitrary slice of the project and
 * quick open is a file list rather than a file switcher.
 *
 * With a query, the match has to lead. Recency ranking a worse match above a
 * better one would be more annoying than no recency at all, so it only breaks
 * ties between equally good matches.
 */

const project = ['src/app.ts', 'src/util.ts', 'src/deep/thing.ts', 'README.md'];

describe('with nothing typed', () => {
  it('leads with the most recently used file', () => {
    expect(rankPaths(project, '', 10, ['README.md'])[0]).toBe('README.md');
  });

  it('keeps the recent files in their own order', () => {
    const order = rankPaths(project, '', 10, ['src/util.ts', 'README.md']);

    expect(order.slice(0, 2)).toEqual(['src/util.ts', 'README.md']);
  });

  it('still offers everything else afterwards', () => {
    const order = rankPaths(project, '', 10, ['README.md']);

    expect(order).toHaveLength(project.length);
    expect(new Set(order)).toEqual(new Set(project));
  });

  it('ignores a remembered file the project no longer has', () => {
    const order = rankPaths(project, '', 10, ['deleted.ts', 'README.md']);

    expect(order).not.toContain('deleted.ts');
    expect(order[0]).toBe('README.md');
  });

  it('falls back to the project order when nothing is remembered', () => {
    expect(rankPaths(project, '', 10, [])).toEqual(project);
  });

  it('respects the limit', () => {
    expect(rankPaths(project, '', 2, ['README.md'])).toHaveLength(2);
  });
});

describe('with a query typed', () => {
  it('lets the better match win over the more recent file', () => {
    // "util" matches src/util.ts far better than src/app.ts, and recency must
    // not overturn that.
    const order = rankPaths(project, 'util', 10, ['src/app.ts']);

    expect(order[0]).toBe('src/util.ts');
  });

  it('uses recency only to break a tie between equal matches', () => {
    const twins = ['a/thing.ts', 'b/thing.ts'];

    expect(rankPaths(twins, 'thing.ts', 10, ['b/thing.ts'])[0]).toBe('b/thing.ts');
    expect(rankPaths(twins, 'thing.ts', 10, ['a/thing.ts'])[0]).toBe('a/thing.ts');
  });

  it('still drops files that do not match at all', () => {
    const order = rankPaths(project, 'util', 10, ['README.md']);

    expect(order).not.toContain('README.md');
  });

  it('behaves exactly as before when no history is passed', () => {
    // The parameter is optional, so every existing caller keeps its ordering.
    expect(rankPaths(project, 'util', 10)).toEqual(rankPaths(project, 'util', 10, []));
  });
});
