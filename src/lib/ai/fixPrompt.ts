import type { Problem } from '@/types';

/**
 * Asking the assistant to fix the error you are looking at.
 *
 * The error is in the Problems list; the assistant is somewhere else. Closing
 * that gap by hand means retyping a path, a line number and a message, and
 * people mostly paste the message alone — which is how the assistant ends up
 * guessing at which file, and fixing a different one.
 *
 * So the prompt is built from the diagnostic itself: the real path, the real
 * position, the compiler's own words, and the actual line of source with a
 * little of what surrounds it. None of it is invented, and where the file is no
 * longer there the prompt says so rather than quoting nothing and letting the
 * model assume.
 */

/** Lines of context either side of the error, so the model can see the shape. */
const CONTEXT_LINES = 4;

/**
 * The source around a diagnostic, numbered as the compiler numbers it.
 *
 * Numbered deliberately: a model told "line 42" and given an unnumbered excerpt
 * has to count, and it miscounts. Returns null when the file is not there, so
 * the caller says that rather than quoting an empty block.
 */
export function excerptAround(
  content: string | undefined,
  line: number,
  radius = CONTEXT_LINES,
): string | null {
  if (content === undefined) return null;
  const lines = content.split('\n');
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;

  const from = Math.max(0, index - radius);
  const to = Math.min(lines.length, index + radius + 1);
  return lines
    .slice(from, to)
    .map((text, offset) => {
      const number = from + offset + 1;
      // The failing line is marked, because "the error is on 42" and a block
      // of numbers is two things the model has to reconcile.
      return `${number === line ? '>' : ' '} ${String(number).padStart(4)}| ${text}`;
    })
    .join('\n');
}

/**
 * The request sent to the assistant for one diagnostic.
 *
 * It asks for a fix and a check, and it says what not to do: a diagnostic
 * silenced with a cast or an ignore comment is not a diagnostic fixed, and it
 * is the cheapest thing for a model under instruction to make an error go away
 * to reach for.
 */
export function fixPrompt(problem: Problem, files: Record<string, string>): string {
  const excerpt = excerptAround(files[problem.path], problem.line);
  const where = `${problem.path}:${problem.line}:${problem.column}`;

  const parts = [
    `Fix this ${problem.severity} reported by ${problem.source} at ${where}:`,
    '',
    problem.message,
    '',
  ];

  if (excerpt) {
    parts.push('The source around it:', '', '```', excerpt, '```', '');
  } else {
    parts.push(
      `I could not quote the source: ${problem.path} is not in the project, or it has fewer than ${problem.line} lines. Read the file yourself before changing anything.`,
      '',
    );
  }

  parts.push(
    'Read the file before editing it. Fix the underlying cause — do not silence the diagnostic ' +
      'with a cast, a non-null assertion, an ignore comment or a widened type unless that is ' +
      'genuinely the right answer and you say why. Then check your work and tell me what the ' +
      'check reported.',
  );

  return parts.join('\n');
}

/** A short label for the activity log, so the request is identifiable later. */
export function fixSummary(problem: Problem): string {
  return `Fix ${problem.severity} at ${problem.path}:${problem.line}`;
}
