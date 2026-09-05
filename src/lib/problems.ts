import type { Problem, ProblemSeverity } from '@/types';
import type { BuildDiagnostic } from '@/lib/bundler';

/**
 * The problem list the panel and the navigation commands share.
 *
 * Two sources report problems: Monaco's language workers, live as you type,
 * and the bundler, when a build runs. Both are real diagnostics about the same
 * files, so they are merged into one ordered list — and ordered *stably*, by
 * file then position, because "go to next problem" is meaningless if the list
 * reshuffles between two presses of the key.
 */

export interface ProblemFilter {
  errors: boolean;
  warnings: boolean;
  info: boolean;
  /** Substring matched against message and path. */
  query: string;
}

export const DEFAULT_PROBLEM_FILTER: ProblemFilter = {
  errors: true,
  warnings: true,
  info: true,
  query: '',
};

/**
 * Build diagnostics, given the shape a `Problem` has.
 *
 * The severity comes from the diagnostic itself rather than from which list it
 * arrived in — the bundler already decided, and re-deciding here is how a
 * warning ends up reported as an error.
 */
export function buildProblems(diagnostics: BuildDiagnostic[]): Problem[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.path)
    .map((diagnostic, index) => ({
      id: `build-${diagnostic.severity}-${index}-${diagnostic.path}-${diagnostic.line}-${diagnostic.column}`,
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      endLine: diagnostic.line,
      endColumn: diagnostic.column,
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: 'esbuild',
    }));
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Merge and order every diagnostic.
 *
 * Sorted by file, then line, then column — the order a reader moves through a
 * project, and the order "next problem" has to follow to feel like anything.
 * Severity only breaks ties at the same position.
 */
export function mergeProblems(sources: Problem[][]): Problem[] {
  const seen = new Set<string>();
  const all: Problem[] = [];
  for (const list of sources) {
    for (const problem of list) {
      // The same diagnostic can arrive from a rebuild and the language worker.
      const fingerprint = `${problem.path}:${problem.line}:${problem.column}:${problem.message}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      all.push(problem);
    }
  }
  return all.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

export function filterProblems(problems: Problem[], filter: ProblemFilter): Problem[] {
  const needle = filter.query.trim().toLowerCase();
  return problems.filter((problem) => {
    if (problem.severity === 'error' && !filter.errors) return false;
    if (problem.severity === 'warning' && !filter.warnings) return false;
    if (problem.severity === 'info' && !filter.info) return false;
    if (!needle) return true;
    return (
      problem.message.toLowerCase().includes(needle) ||
      problem.path.toLowerCase().includes(needle) ||
      problem.source.toLowerCase().includes(needle)
    );
  });
}

export interface ProblemGroup {
  path: string;
  problems: Problem[];
  errors: number;
  warnings: number;
}

/** Group by file, preserving the merged order within each group. */
export function groupProblems(problems: Problem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const problem of problems) {
    let group = groups.get(problem.path);
    if (!group) {
      group = { path: problem.path, problems: [], errors: 0, warnings: 0 };
      groups.set(problem.path, group);
    }
    group.problems.push(problem);
    if (problem.severity === 'error') group.errors += 1;
    else if (problem.severity === 'warning') group.warnings += 1;
  }
  return [...groups.values()];
}

/**
 * The problem to jump to from where the caret is now.
 *
 * Wraps at both ends, and treats "the problem the caret is already on" as
 * behind you going forward and ahead of you going back, so repeated presses
 * always move rather than sticking on the current one.
 */
export function nextProblem(
  problems: Problem[],
  from: { path: string; line: number; column: number } | null,
  direction: 1 | -1,
): Problem | null {
  if (!problems.length) return null;
  if (!from) return direction === 1 ? problems[0] : problems[problems.length - 1];

  const isAfter = (problem: Problem) =>
    problem.path > from.path ||
    (problem.path === from.path &&
      (problem.line > from.line || (problem.line === from.line && problem.column > from.column)));

  if (direction === 1) {
    return problems.find(isAfter) ?? problems[0];
  }
  const before = problems.filter(
    (problem) =>
      problem.path < from.path ||
      (problem.path === from.path &&
        (problem.line < from.line ||
          (problem.line === from.line && problem.column < from.column))),
  );
  return before[before.length - 1] ?? problems[problems.length - 1];
}

export function countBySeverity(problems: Problem[]): Record<ProblemSeverity, number> {
  const counts: Record<ProblemSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const problem of problems) counts[problem.severity] += 1;
  return counts;
}
