import type { Problem, ProblemSeverity } from '@/types';

/**
 * Monaco's markers, turned into the problem list the panels read.
 *
 * Pulled out of the editor component because the interesting property is not
 * what it produces but how often it produces something *new*. The language
 * services re-emit markers continuously while you type — the same diagnostics,
 * re-reported, many times per second — and every pass used to build a fresh
 * array of fresh objects carrying freshly generated ids.
 *
 * Nothing downstream could tell that nothing had changed. The store wrote a
 * new array, so every subscriber re-rendered; the React key was the generated
 * id, so the Problems list unmounted and rebuilt every row; and anything
 * memoised on the problem list — the assistant's context, for one — was
 * invalidated on each pass for a set of problems that were identical to the
 * ones it already had.
 *
 * So identity here is derived from the diagnostic rather than minted for it.
 * The same problem in the same place keeps the same id between passes, which
 * is what makes {@link problemsSignature} able to say "this is the list you
 * already have" and the caller able to publish nothing.
 */

/** Monaco's numeric `MarkerSeverity`, which this file does not import for one map. */
const SEVERITY: Record<number, ProblemSeverity> = {
  8: 'error',
  4: 'warning',
  2: 'info',
  1: 'info',
};

/** The shape of a Monaco marker, narrowed to what a problem is built from. */
export interface MarkerLike {
  resource: { scheme: string; path: string };
  severity: number;
  message: string;
  owner?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * A stable identity for one diagnostic.
 *
 * Everything a reader of the list can see goes into it, so two problems with
 * the same id really are the same problem — and a message that changed, or a
 * diagnostic that moved a line, is correctly a different one.
 */
function identify(marker: MarkerLike, path: string, severity: ProblemSeverity): string {
  const source = marker.owner ?? 'editor';
  return `${source}:${path}:${marker.startLineNumber}:${marker.startColumn}:${severity}:${marker.message}`;
}

/**
 * Problems from markers, ordered by file and line.
 *
 * Only in-memory resources: the editor's models are the project's files, and a
 * marker on anything else belongs to a document the user has no way to open.
 */
export function problemsFromMarkers(markers: readonly MarkerLike[]): Problem[] {
  return markers
    .filter((marker) => marker.resource.scheme === 'inmemory')
    .map((marker) => {
      const path = marker.resource.path.replace(/^\//, '');
      const severity = SEVERITY[marker.severity] ?? 'info';
      return {
        id: identify(marker, path, severity),
        path,
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
        severity,
        message: marker.message,
        source: marker.owner ?? 'editor',
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * What this list *is*, for comparing against the last one published.
 *
 * The ids already encode the source, path, position, severity and message, so
 * they are the whole of the difference a reader could notice. The separator is
 * a NUL because it cannot occur inside a diagnostic message, and written as an
 * escape because a literal control byte in a source file makes every tool that
 * reads it treat the file as binary.
 */
export function problemsSignature(problems: readonly Problem[]): string {
  return problems.map((problem) => problem.id).join('\u0000');
}
