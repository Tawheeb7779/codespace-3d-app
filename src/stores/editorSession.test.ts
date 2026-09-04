import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore, MAX_REMEMBERED_PROJECTS } from '@/stores/editorStore';

/**
 * Reopening a project where you left it.
 *
 * The failure mode this guards against is not losing tabs — it is restoring
 * ones that no longer exist. A session written before a file was deleted (or
 * before a branch checkout replaced the tree) must not reopen a file the
 * project does not have.
 */

const store = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activePath: null,
    cursor: { line: 1, column: 1 },
    reveal: null,
    splitPath: null,
    sessions: {},
  });
});

const has = (...paths: string[]) => (path: string) => paths.includes(path);

describe('remembering a session', () => {
  it('stores the open tabs, the active file and its caret', () => {
    store().openTab('src/a.ts');
    store().openTab('src/b.ts');
    store().setCursor(42, 7);
    store().rememberSession('p1');

    const saved = store().sessions.p1;
    expect(saved.tabs.map((tab) => tab.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(saved.activePath).toBe('src/b.ts');
    expect(saved.cursors['src/b.ts']).toEqual({ line: 42, column: 7 });
  });

  it('drops carets for files that are no longer open', () => {
    store().openTab('src/a.ts');
    store().setCursor(10, 1);
    store().rememberSession('p1');
    store().openTab('src/b.ts');
    store().closeTab('src/a.ts');
    store().rememberSession('p1');

    expect(store().sessions.p1.cursors['src/a.ts']).toBeUndefined();
  });

  it('keeps only a bounded number of projects', () => {
    for (let index = 0; index < MAX_REMEMBERED_PROJECTS + 4; index++) {
      store().openTab(`src/file-${index}.ts`);
      store().rememberSession(`project-${index}`);
    }
    expect(Object.keys(store().sessions).length).toBeLessThanOrEqual(MAX_REMEMBERED_PROJECTS);
    // The one just written always survives the trim.
    expect(store().sessions[`project-${MAX_REMEMBERED_PROJECTS + 3}`]).toBeDefined();
  });
});

describe('restoring a session', () => {
  it('reopens the tabs and puts the caret back', () => {
    store().openTab('src/a.ts');
    store().openTab('src/b.ts');
    store().setCursor(12, 3);
    store().rememberSession('p1');
    store().closeAll();

    expect(store().restoreSession('p1', has('src/a.ts', 'src/b.ts'))).toBe(true);
    expect(store().tabs.map((tab) => tab.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(store().activePath).toBe('src/b.ts');
    expect(store().reveal).toMatchObject({ path: 'src/b.ts', line: 12, column: 3 });
  });

  /** The case that would reopen a deleted file, or one from another branch. */
  it('skips files the project no longer has', () => {
    store().openTab('src/gone.ts');
    store().openTab('src/here.ts');
    store().rememberSession('p1');
    store().closeAll();

    expect(store().restoreSession('p1', has('src/here.ts'))).toBe(true);
    expect(store().tabs.map((tab) => tab.path)).toEqual(['src/here.ts']);
    expect(store().activePath).toBe('src/here.ts');
  });

  it('reports nothing to restore rather than opening an empty editor', () => {
    store().openTab('src/gone.ts');
    store().rememberSession('p1');
    store().closeAll();

    expect(store().restoreSession('p1', has())).toBe(false);
    expect(store().tabs).toEqual([]);
    expect(store().restoreSession('never-opened', has('anything'))).toBe(false);
  });

  it('forgets a project on request', () => {
    store().openTab('src/a.ts');
    store().rememberSession('p1');
    store().forgetSession('p1');
    expect(store().restoreSession('p1', has('src/a.ts'))).toBe(false);
  });
});
