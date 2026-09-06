import { beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { StatusBar } from '@/components/ide/StatusBar';
import { useEditorStore } from '@/stores/editorStore';
import { useFileStore } from '@/stores/fileStore';
import { useGitStore } from '@/stores/gitStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useAuthStore } from '@/stores/authStore';
import type { Problem, ProblemSeverity } from '@/types';

/**
 * The status bar under a DOM that something else is rewriting.
 *
 * Chrome's translate, Grammarly, password managers and accessibility overlays
 * all work the same way: they walk the document and swap text nodes for
 * elements carrying replacement text. React keeps a reference to the node it
 * created, and when a later render has to remove or insert around it, the
 * commit calls `removeChild` with a node that is no longer a child:
 *
 *   Failed to execute 'removeChild' on 'Node': The node to be removed is not
 *   a child of this node
 *
 * Only one shape in this component is exposed to that. A bare text node whose
 * *slot* never changes is only ever updated through `nodeValue`, which cannot
 * throw — the problem counts, the cursor position and the language label are
 * all that shape. The dangerous shape is a bare text node that is a sibling of
 * a conditionally mounted element inside a parent that survives the change,
 * because then React has to remove or insert around a node it no longer owns.
 *
 * Two readings had it: the preview status, which moves through
 * idle -> building -> running/error, and the save state, which moves through
 * saving -> unsaved -> saved. Both rendered `<Loader2/> text` in one branch and
 * a bare string in the others.
 */

const translate = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.textContent?.trim()) texts.push(node);
  }
  for (const node of texts) {
    const font = document.createElement('font');
    font.textContent = node.textContent;
    node.parentNode?.replaceChild(font, node);
  }
  return texts.length;
};

const problem = (id: string, severity: ProblemSeverity): Problem => ({
  id,
  path: 'a.ts',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  severity,
  message: id,
  source: 'typescript',
});

const setPreview = (status: 'idle' | 'building' | 'running' | 'error') =>
  act(() => {
    usePreviewStore.setState({ status });
  });

const setSave = (patch: { saving?: boolean; dirty?: Set<string>; lastSavedAt?: number | null }) =>
  act(() => {
    useFileStore.setState({
      saving: false,
      dirty: new Set(),
      lastSavedAt: null,
      role: 'owner',
      ...patch,
    });
  });

beforeEach(() => {
  useAuthStore.setState({ localMode: true });
  useGitStore.setState({
    repo: { ...useGitStore.getState().repo, initialized: false },
    status: { ...useGitStore.getState().status, clean: true, staged: [], unstaged: [] },
  });
  useEditorStore.setState({ activePath: 'src/main.ts', cursor: { line: 1, column: 1 }, problems: [] });
  setSave({});
  setPreview('idle');
});

describe('the preview status moves through its whole cycle', () => {
  it('survives idle -> building -> running -> error -> idle untranslated', () => {
    render(<StatusBar />);
    for (const status of ['building', 'running', 'error', 'idle', 'building', 'error'] as const) {
      expect(() => setPreview(status)).not.toThrow();
    }
  });

  /** The reproduction: rewrite the text, then force the transition. */
  it('survives the same cycle with every text node replaced at each step', () => {
    const { container } = render(<StatusBar />);
    setPreview('building');
    expect(container.textContent).toContain('building');

    // Something else rewrites the bar, exactly as a translator does.
    expect(translate(container)).toBeGreaterThan(0);

    // building -> error is where React must remove what it rendered.
    expect(() => setPreview('error')).not.toThrow();
    translate(container);
    expect(() => setPreview('running')).not.toThrow();
    translate(container);
    expect(() => setPreview('building')).not.toThrow();
    translate(container);
    expect(() => setPreview('idle')).not.toThrow();
  });

  it('still shows the right reading after the rewriting stops', () => {
    const { container } = render(<StatusBar />);
    setPreview('building');
    translate(container);
    setPreview('error');
    // React re-renders the branch it owns; the stale nodes are gone with it.
    expect(container.textContent).toContain('build failed');
  });
});

describe('the save state moves through its whole cycle', () => {
  it('survives saving -> unsaved -> saved -> no changes untranslated', () => {
    render(<StatusBar />);
    expect(() => setSave({ saving: true })).not.toThrow();
    expect(() => setSave({ dirty: new Set(['a.ts']) })).not.toThrow();
    expect(() => setSave({ lastSavedAt: Date.now() - 60_000 })).not.toThrow();
    expect(() => setSave({})).not.toThrow();
  });

  it('survives the same cycle with every text node replaced at each step', () => {
    const { container } = render(<StatusBar />);
    setSave({ saving: true });
    expect(container.textContent).toContain('saving');

    expect(translate(container)).toBeGreaterThan(0);
    expect(() => setSave({ dirty: new Set(['a.ts', 'b.ts']) })).not.toThrow();
    translate(container);
    expect(() => setSave({ lastSavedAt: Date.now() - 60_000 })).not.toThrow();
    translate(container);
    expect(() => setSave({ saving: true })).not.toThrow();
    translate(container);
    expect(() => setSave({})).not.toThrow();
  });
});

describe('both readings changing together, under rewriting', () => {
  it('survives a build failing while a save completes', () => {
    const { container } = render(<StatusBar />);
    setPreview('building');
    setSave({ saving: true });
    translate(container);

    expect(() => {
      act(() => {
        usePreviewStore.setState({ status: 'error' });
        useFileStore.setState({ saving: false, lastSavedAt: Date.now(), dirty: new Set() });
      });
    }).not.toThrow();
  });
});

describe('the readings that are not exposed to this', () => {
  /**
   * A text node whose slot never changes is only ever written through
   * `nodeValue`. That silently does nothing on a detached node — it cannot
   * throw — so these need no wrapper and did not get one.
   */
  it('updates problem counts, cursor and language without structural churn', () => {
    const { container } = render(<StatusBar />);
    translate(container);

    expect(() => {
      act(() => {
        useEditorStore.setState({
          problems: [
            problem('one', 'error'),
            problem('two', 'warning'),
          ],
          cursor: { line: 42, column: 7 },
          activePath: 'src/other.tsx',
        });
      });
    }).not.toThrow();
  });

  it('mounts and unmounts whole readings without touching their innards', () => {
    const { container } = render(<StatusBar />);
    translate(container);
    // Losing the active file removes three readings at once; React drops each
    // reading's own element, never the rewritten text inside it.
    expect(() => act(() => useEditorStore.setState({ activePath: null }))).not.toThrow();
    expect(() => act(() => useEditorStore.setState({ activePath: 'src/main.ts' }))).not.toThrow();
  });
});
