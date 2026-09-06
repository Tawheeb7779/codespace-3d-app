import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '@/stores/editorStore';

/**
 * What closing tabs is allowed to leave behind.
 *
 * Tabs and file contents are separate here: closing a tab stops showing a file,
 * it never discards an edit, which is why none of these ask for confirmation.
 * What they must not do is leave the workspace referring to something that is
 * no longer open — the split pane renders `splitPath` whether or not a tab
 * still exists for it, and pointing it at a closed file lit the split button
 * over an empty pane.
 */

const open = (paths: string[], active = paths[paths.length - 1]) => {
  useEditorStore.setState({
    tabs: paths.map((path) => ({ path, pinned: false })),
    activePath: active,
    splitPath: null,
  });
};

const paths = () => useEditorStore.getState().tabs.map((tab) => tab.path);

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activePath: null, splitPath: null });
});

describe('closing the other tabs', () => {
  it('drops a split pointing at one of the tabs it closed', () => {
    open(['a.ts', 'b.ts', 'c.ts']);
    useEditorStore.setState({ splitPath: 'c.ts' });

    useEditorStore.getState().closeOthers('a.ts');

    expect(paths()).toEqual(['a.ts']);
    expect(useEditorStore.getState().splitPath).toBeNull();
  });

  it('keeps a split that is still open', () => {
    open(['a.ts', 'b.ts']);
    useEditorStore.setState({
      tabs: [
        { path: 'a.ts', pinned: false },
        { path: 'b.ts', pinned: true },
      ],
      splitPath: 'b.ts',
    });

    useEditorStore.getState().closeOthers('a.ts');

    expect(paths()).toEqual(['a.ts', 'b.ts']);
    expect(useEditorStore.getState().splitPath).toBe('b.ts');
  });
});

describe('closing the saved tabs', () => {
  const dirty = (...unsaved: string[]) => {
    const set = new Set(unsaved);
    return (path: string) => set.has(path);
  };

  it('keeps the files with unsaved work and closes the rest', () => {
    open(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

    useEditorStore.getState().closeSaved(dirty('b.ts', 'd.ts'));

    expect(paths()).toEqual(['b.ts', 'd.ts']);
  });

  it('keeps pinned tabs even when they are saved', () => {
    useEditorStore.setState({
      tabs: [
        { path: 'a.ts', pinned: true },
        { path: 'b.ts', pinned: false },
      ],
      activePath: 'b.ts',
    });

    useEditorStore.getState().closeSaved(dirty());

    expect(paths()).toEqual(['a.ts']);
    // The active file went with the tabs, so focus moves to what is left.
    expect(useEditorStore.getState().activePath).toBe('a.ts');
  });

  it('leaves the active file alone when it is one of the survivors', () => {
    open(['a.ts', 'b.ts', 'c.ts'], 'b.ts');

    useEditorStore.getState().closeSaved(dirty('b.ts'));

    expect(useEditorStore.getState().activePath).toBe('b.ts');
  });

  it('closes everything, and names nothing active, when nothing is unsaved', () => {
    open(['a.ts', 'b.ts']);

    useEditorStore.getState().closeSaved(dirty());

    expect(paths()).toEqual([]);
    expect(useEditorStore.getState().activePath).toBeNull();
  });

  it('drops a split whose file it closed', () => {
    open(['a.ts', 'b.ts']);
    useEditorStore.setState({ splitPath: 'a.ts' });

    useEditorStore.getState().closeSaved(dirty('b.ts'));

    expect(useEditorStore.getState().splitPath).toBeNull();
  });
});
