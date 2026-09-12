// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentContextSections, resetContextCache, useAiStore } from '@/stores/aiStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import * as contextControl from '@/lib/ai/contextControl';

/**
 * How often the assistant recomputes what it would send.
 *
 * This is called from the panel's render, and during a streamed answer the
 * panel renders once per token. It walks the whole file map — `readableFiles`
 * copies every entry — so on a 2,000-file project it was about a millisecond
 * of work and a 2,000-key allocation per token, for an answer that is the same
 * every time because nothing it depends on has changed while text arrives.
 *
 * The tests that matter are the two halves of that claim: repeating the call
 * costs nothing, and it is still *correct* — every input that can change a
 * section does change the answer. A cache that were only fast would be worse
 * than no cache, because the assistant would send context from before the edit
 * the user just made.
 */

function project(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) files[`src/mod${i % 20}/file${i}.ts`] = `export const v${i} = ${i};\n`;
  return files;
}

const baseline = () => {
  resetContextCache();
  useFileStore.setState({ files: project(50), dirs: [] } as never);
  useEditorStore.setState({
    activePath: 'src/mod0/file0.ts',
    tabs: [{ path: 'src/mod0/file0.ts', pinned: false }],
    problems: [],
  } as never);
  useAiStore.setState({ context: { ...contextControl.DEFAULT_CONTEXT }, selection: '' } as never);
};

beforeEach(baseline);
afterEach(() => vi.restoreAllMocks());

describe('repeating the question', () => {
  it('does not rebuild the sections when nothing changed', () => {
    const spy = vi.spyOn(contextControl, 'buildContextSections');

    currentContextSections();
    const afterFirst = spy.mock.calls.length;
    for (let i = 0; i < 200; i++) currentContextSections();

    expect(afterFirst).toBe(1);
    expect(spy.mock.calls.length).toBe(1);
  });

  it('returns the very same array, so a consumer memoising on it also holds', () => {
    expect(currentContextSections()).toBe(currentContextSections());
  });
});

describe('noticing a change', () => {
  /** Each of these can alter a section, so each must invalidate. */
  const changes: Array<[string, () => void]> = [
    ['an edit to a file', () => useFileStore.setState({ files: project(51) } as never)],
    [
      'the active file',
      () => useEditorStore.setState({ activePath: 'src/mod1/file1.ts' } as never),
    ],
    [
      'the open tabs',
      () =>
        useEditorStore.setState({
          tabs: [
            { path: 'src/mod0/file0.ts', pinned: false },
            { path: 'src/mod1/file1.ts', pinned: false },
          ],
        } as never),
    ],
    [
      'a new diagnostic',
      () =>
        useEditorStore.setState({
          problems: [
            {
              id: 'p1',
              path: 'src/mod0/file0.ts',
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 2,
              severity: 'error',
              message: 'boom',
              source: 'typescript',
            },
          ],
        } as never),
    ],
    ['the selection', () => useAiStore.setState({ selection: 'const x = 1;' } as never)],
    [
      'a context toggle',
      () =>
        useAiStore.setState({
          context: { ...contextControl.DEFAULT_CONTEXT, openFiles: true },
        } as never),
    ],
  ];

  for (const [what, apply] of changes) {
    it(`rebuilds after ${what}`, () => {
      const spy = vi.spyOn(contextControl, 'buildContextSections');
      currentContextSections();
      expect(spy.mock.calls.length).toBe(1);

      apply();
      currentContextSections();

      expect(spy.mock.calls.length).toBe(2);
    });
  }

  it('reflects the change rather than serving the previous answer', () => {
    useAiStore.setState({ selection: '' } as never);
    expect(currentContextSections().some((s) => s.source === 'selection')).toBe(false);

    useAiStore.setState({ selection: 'const answer = 42;' } as never);
    const after = currentContextSections();

    const selection = after.find((section) => section.source === 'selection');
    expect(selection?.body).toContain('const answer = 42;');
  });

  it('drops everything it held when the cache is reset', () => {
    const spy = vi.spyOn(contextControl, 'buildContextSections');
    currentContextSections();
    resetContextCache();
    currentContextSections();

    expect(spy.mock.calls.length).toBe(2);
  });
});

describe('what it does not read', () => {
  /**
   * The terminal buffer is off by default and rendering it is not free, so it
   * was being built on every render for a section most turns never send.
   */
  it('does not render the terminal buffer when that source is off', () => {
    useAiStore.setState({
      context: { ...contextControl.DEFAULT_CONTEXT, terminal: false },
    } as never);
    const spy = vi.spyOn(contextControl, 'buildContextSections');

    currentContextSections();

    expect(spy.mock.calls[0][1].terminalOutput).toBe('');
  });
});
