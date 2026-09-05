// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROBLEM_FILTER,
  buildProblems,
  countBySeverity,
  filterProblems,
  groupProblems,
  mergeProblems,
  nextProblem,
} from '@/lib/problems';
import type { Problem } from '@/types';

/**
 * Problem navigation is the reason this list is ordered rather than merely
 * collected. "Next problem" has to move through a project the way a reader
 * does — file by file, top to bottom — and it has to keep moving when pressed
 * repeatedly, which is what most of these cover.
 */

const problem = (path: string, line: number, column = 1, severity: Problem['severity'] = 'error'): Problem => ({
  id: `${path}:${line}:${column}`,
  path,
  line,
  column,
  endLine: line,
  endColumn: column,
  severity,
  message: `${severity} at ${path}:${line}`,
  source: 'ts',
});

describe('merging diagnostics', () => {
  it('orders by file, then line, then column', () => {
    const merged = mergeProblems([
      [problem('src/b.ts', 5), problem('src/a.ts', 10)],
      [problem('src/a.ts', 2, 8), problem('src/a.ts', 2, 3)],
    ]);
    expect(merged.map((p) => `${p.path}:${p.line}:${p.column}`)).toEqual([
      'src/a.ts:2:3',
      'src/a.ts:2:8',
      'src/a.ts:10:1',
      'src/b.ts:5:1',
    ]);
  });

  /** A rebuild and the language worker can report the same error. */
  it('drops duplicates reported by two sources', () => {
    const fromWorker = problem('src/a.ts', 3);
    const fromBuild = { ...problem('src/a.ts', 3), id: 'build-0', source: 'esbuild' };
    expect(mergeProblems([[fromWorker], [fromBuild]])).toHaveLength(1);
  });

  it('keeps two different problems at the same position', () => {
    const a = problem('src/a.ts', 3);
    const b = { ...problem('src/a.ts', 3), id: 'other', message: 'a different error' };
    expect(mergeProblems([[a, b]])).toHaveLength(2);
  });

  it('converts build diagnostics, skipping ones with no file', () => {
    const built = buildProblems([
      { path: 'src/a.ts', line: 4, column: 2, message: 'boom', severity: 'error' },
      { path: 'src/b.ts', line: 1, column: 1, message: 'careful', severity: 'warning' },
      { path: '', line: 0, column: 0, message: 'no file', severity: 'error' },
    ]);
    expect(built).toHaveLength(2);
    expect(built[0]).toMatchObject({ path: 'src/a.ts', severity: 'error', source: 'esbuild' });
    // The bundler's own severity is kept, not re-decided here.
    expect(built[1].severity).toBe('warning');
  });
});

describe('filtering', () => {
  const all = [
    problem('src/a.ts', 1, 1, 'error'),
    problem('src/a.ts', 2, 1, 'warning'),
    problem('src/b.ts', 3, 1, 'info'),
  ];

  it('shows everything by default', () => {
    expect(filterProblems(all, DEFAULT_PROBLEM_FILTER)).toHaveLength(3);
  });

  it('hides a severity when it is turned off', () => {
    const errorsOnly = filterProblems(all, {
      ...DEFAULT_PROBLEM_FILTER,
      warnings: false,
      info: false,
    });
    expect(errorsOnly.map((p) => p.severity)).toEqual(['error']);
  });

  it('matches the query against message, path and source', () => {
    expect(filterProblems(all, { ...DEFAULT_PROBLEM_FILTER, query: 'src/b' })).toHaveLength(1);
    expect(filterProblems(all, { ...DEFAULT_PROBLEM_FILTER, query: 'warning at' })).toHaveLength(1);
    expect(filterProblems(all, { ...DEFAULT_PROBLEM_FILTER, query: 'ts' })).toHaveLength(3);
    expect(filterProblems(all, { ...DEFAULT_PROBLEM_FILTER, query: 'nothing' })).toHaveLength(0);
  });

  it('counts by severity', () => {
    expect(countBySeverity(all)).toEqual({ error: 1, warning: 1, info: 1 });
  });
});

describe('grouping', () => {
  it('groups by file and counts each severity', () => {
    const groups = groupProblems(
      mergeProblems([
        [
          problem('src/a.ts', 1, 1, 'error'),
          problem('src/a.ts', 2, 1, 'warning'),
          problem('src/b.ts', 1, 1, 'error'),
        ],
      ]),
    );
    expect(groups.map((group) => group.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(groups[0]).toMatchObject({ errors: 1, warnings: 1 });
  });
});

describe('navigation', () => {
  const ordered = mergeProblems([
    [problem('src/a.ts', 5), problem('src/a.ts', 12), problem('src/b.ts', 2)],
  ]);

  it('starts at the first or last problem when nowhere in particular', () => {
    expect(nextProblem(ordered, null, 1)?.line).toBe(5);
    expect(nextProblem(ordered, null, -1)?.path).toBe('src/b.ts');
  });

  it('moves past the problem the caret already sits on', () => {
    const from = { path: 'src/a.ts', line: 5, column: 1 };
    expect(nextProblem(ordered, from, 1)?.line).toBe(12);
    // And backwards from the same spot goes to the previous one, not itself.
    const fromLater = { path: 'src/a.ts', line: 12, column: 1 };
    expect(nextProblem(ordered, fromLater, -1)?.line).toBe(5);
  });

  it('crosses into the next file', () => {
    const from = { path: 'src/a.ts', line: 12, column: 1 };
    expect(nextProblem(ordered, from, 1)?.path).toBe('src/b.ts');
  });

  it('wraps at both ends rather than stopping', () => {
    const atEnd = { path: 'src/b.ts', line: 2, column: 1 };
    expect(nextProblem(ordered, atEnd, 1)?.line).toBe(5);
    const atStart = { path: 'src/a.ts', line: 5, column: 1 };
    expect(nextProblem(ordered, atStart, -1)?.path).toBe('src/b.ts');
  });

  it('returns nothing when there is nothing to go to', () => {
    expect(nextProblem([], null, 1)).toBeNull();
    expect(nextProblem([], { path: 'src/a.ts', line: 1, column: 1 }, -1)).toBeNull();
  });
});
