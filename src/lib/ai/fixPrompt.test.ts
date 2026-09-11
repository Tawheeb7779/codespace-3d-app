import { describe, expect, it } from 'vitest';
import { excerptAround, fixPrompt, fixSummary } from '@/lib/ai/fixPrompt';
import type { Problem } from '@/types';

/**
 * Handing one diagnostic to the assistant without losing it on the way.
 *
 * The failure this replaces is a person pasting a compiler message with no path
 * into the chat, and the assistant confidently fixing a different file. So the
 * prompt is checked to carry the real path and position, and to quote the real
 * line rather than an approximation of it.
 *
 * And when the file cannot be quoted — it was deleted, or the diagnostic is
 * stale and points past the end — the prompt has to say so. A prompt that
 * silently quotes nothing reads to a model as "there is nothing there", which
 * is a different claim from "I could not look".
 */

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    id: 'p1',
    path: 'src/App.tsx',
    line: 3,
    column: 7,
    endLine: 3,
    endColumn: 11,
    severity: 'error',
    message: "Type 'string' is not assignable to type 'number'.",
    source: 'ts',
    ...overrides,
  };
}

const FILE = ['const a = 1;', 'const b = 2;', 'const c: number = "x";', 'const d = 4;'].join('\n');

describe('quoting the source', () => {
  it('includes the failing line', () => {
    const excerpt = excerptAround(FILE, 3);

    expect(excerpt).toContain('const c: number = "x";');
  });

  it('numbers the lines as the compiler does', () => {
    const excerpt = excerptAround(FILE, 3, 1);

    expect(excerpt).toBe(
      ['     2| const b = 2;', '>    3| const c: number = "x";', '     4| const d = 4;'].join('\n'),
    );
  });

  it('marks the failing line so it need not be counted to', () => {
    expect(excerptAround(FILE, 3, 1)!.split('\n')[1].startsWith('>')).toBe(true);
  });

  it('does not run off either end of the file', () => {
    expect(excerptAround(FILE, 1, 10)!.split('\n')).toHaveLength(4);
    expect(excerptAround(FILE, 4, 10)!.split('\n')).toHaveLength(4);
  });

  /** A stale diagnostic can point past the end of a file that shrank. */
  it('reports no excerpt for a line that does not exist', () => {
    expect(excerptAround(FILE, 99)).toBeNull();
    expect(excerptAround(FILE, 0)).toBeNull();
  });

  it('reports no excerpt for a file that is not there', () => {
    expect(excerptAround(undefined, 3)).toBeNull();
  });
});

describe('the prompt', () => {
  const files = { 'src/App.tsx': FILE };

  it('names the file, the position and where the diagnostic came from', () => {
    const prompt = fixPrompt(problem(), files);

    expect(prompt).toContain('src/App.tsx:3:7');
    expect(prompt).toContain('reported by ts');
    expect(prompt).toContain('Fix this error');
  });

  it('carries the compiler’s own words', () => {
    expect(fixPrompt(problem(), files)).toContain(
      "Type 'string' is not assignable to type 'number'.",
    );
  });

  it('quotes the real source', () => {
    expect(fixPrompt(problem(), files)).toContain('const c: number = "x";');
  });

  /**
   * The instruction that matters: silencing a diagnostic is the cheapest way to
   * make it disappear, and it leaves the bug.
   */
  it('tells the assistant not to silence the diagnostic', () => {
    const prompt = fixPrompt(problem(), files);

    expect(prompt).toMatch(/do not silence the diagnostic/i);
    expect(prompt).toMatch(/ignore comment/i);
    expect(prompt).toMatch(/underlying cause/i);
  });

  it('asks for a check and for what it reported', () => {
    expect(fixPrompt(problem(), files)).toMatch(/check your work and tell me what the check reported/i);
  });

  /** Saying "I could not look" rather than quoting an empty block. */
  it('says when it could not quote the file', () => {
    const prompt = fixPrompt(problem({ path: 'src/Gone.tsx' }), files);

    expect(prompt).toMatch(/could not quote the source/i);
    expect(prompt).toMatch(/Read the file yourself/i);
    expect(prompt).not.toContain('```');
  });

  it('carries the severity it was actually given', () => {
    expect(fixPrompt(problem({ severity: 'warning' }), files)).toContain('Fix this warning');
  });
});

describe('the summary', () => {
  it('identifies the request by where it was', () => {
    expect(fixSummary(problem())).toBe('Fix error at src/App.tsx:3');
  });
});
