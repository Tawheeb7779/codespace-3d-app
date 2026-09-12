// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { problemsFromMarkers, problemsSignature, type MarkerLike } from '@/lib/diagnostics';

/**
 * Whether the same diagnostics are recognised as the same diagnostics.
 *
 * That is the whole point of this module, and it is a performance property
 * expressed as a correctness one: the language services re-report identical
 * markers many times while a person types, and nothing downstream can skip
 * work unless identical input produces identical output. So these check
 * identity and stability first, and the mapping second.
 */

const marker = (patch: Partial<MarkerLike> = {}): MarkerLike => ({
  resource: { scheme: 'inmemory', path: '/src/app.ts' },
  severity: 8,
  message: "Cannot find name 'x'.",
  owner: 'typescript',
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 6,
  ...patch,
});

describe('recognising a repeated diagnostic', () => {
  /** The property everything above this depends on. */
  it('gives the same problem the same id on a second pass', () => {
    const first = problemsFromMarkers([marker()]);
    const second = problemsFromMarkers([marker()]);

    expect(second[0].id).toBe(first[0].id);
    expect(problemsSignature(second)).toBe(problemsSignature(first));
  });

  it('gives a moved diagnostic a different id', () => {
    const before = problemsFromMarkers([marker({ startLineNumber: 3 })]);
    const after = problemsFromMarkers([marker({ startLineNumber: 4 })]);

    expect(after[0].id).not.toBe(before[0].id);
    expect(problemsSignature(after)).not.toBe(problemsSignature(before));
  });

  it('gives a changed message a different id', () => {
    const before = problemsFromMarkers([marker({ message: 'one' })]);
    const after = problemsFromMarkers([marker({ message: 'two' })]);

    expect(problemsSignature(after)).not.toBe(problemsSignature(before));
  });

  it('separates a warning from an error in the same place', () => {
    const error = problemsFromMarkers([marker({ severity: 8 })]);
    const warning = problemsFromMarkers([marker({ severity: 4 })]);

    expect(warning[0].id).not.toBe(error[0].id);
  });

  it('separates two diagnostics whose messages run together', () => {
    // A separator that can occur inside a message would let "a" + "b" and
    // "a b" produce the same signature.
    const pair = problemsFromMarkers([
      marker({ message: 'a', startColumn: 1 }),
      marker({ message: 'b', startColumn: 2 }),
    ]);
    const single = problemsFromMarkers([marker({ message: 'a b', startColumn: 1 })]);

    expect(problemsSignature(pair)).not.toBe(problemsSignature(single));
  });

  it('notices one diagnostic disappearing from a set', () => {
    const both = problemsFromMarkers([marker({ startColumn: 1 }), marker({ startColumn: 9 })]);
    const one = problemsFromMarkers([marker({ startColumn: 1 })]);

    expect(problemsSignature(one)).not.toBe(problemsSignature(both));
  });

  it('treats an empty set as its own signature, not as nothing to compare', () => {
    expect(problemsSignature(problemsFromMarkers([]))).toBe('');
    expect(problemsSignature(problemsFromMarkers([marker()]))).not.toBe('');
  });
});

describe('what a marker becomes', () => {
  it('reads position, severity and source from the marker', () => {
    expect(problemsFromMarkers([marker()])[0]).toMatchObject({
      path: 'src/app.ts',
      line: 3,
      column: 5,
      endLine: 3,
      endColumn: 6,
      severity: 'error',
      message: "Cannot find name 'x'.",
      source: 'typescript',
    });
  });

  it('maps every severity Monaco emits', () => {
    const severities = [8, 4, 2, 1].map(
      (severity) => problemsFromMarkers([marker({ severity })])[0].severity,
    );
    expect(severities).toEqual(['error', 'warning', 'info', 'info']);
  });

  it('calls an unknown severity info rather than dropping the diagnostic', () => {
    expect(problemsFromMarkers([marker({ severity: 99 })])[0].severity).toBe('info');
  });

  /** A marker on something the user cannot open is not a project problem. */
  it('ignores markers on resources that are not project files', () => {
    const problems = problemsFromMarkers([
      marker(),
      marker({ resource: { scheme: 'file', path: '/etc/passwd' } }),
      marker({ resource: { scheme: 'vscode', path: '/settings.json' } }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('src/app.ts');
  });

  it('orders by file and then by line', () => {
    const problems = problemsFromMarkers([
      marker({ resource: { scheme: 'inmemory', path: '/b.ts' }, startLineNumber: 1 }),
      marker({ resource: { scheme: 'inmemory', path: '/a.ts' }, startLineNumber: 9 }),
      marker({ resource: { scheme: 'inmemory', path: '/a.ts' }, startLineNumber: 2 }),
    ]);

    expect(problems.map((problem) => `${problem.path}:${problem.line}`)).toEqual([
      'a.ts:2',
      'a.ts:9',
      'b.ts:1',
    ]);
  });

  it('falls back to a named source when the marker has no owner', () => {
    expect(problemsFromMarkers([marker({ owner: undefined })])[0].source).toBe('editor');
  });
});
