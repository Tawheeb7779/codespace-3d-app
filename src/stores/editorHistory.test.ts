import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_CLOSED, MAX_RECENT, useEditorStore } from '@/stores/editorStore';

/**
 * What you were just working on.
 *
 * Two histories, both paths only — never file contents — so neither can carry
 * code or a secret into storage, and both bounded, because their whole job is
 * "the handful you were just in".
 *
 * `recent` is what makes quick open a file switcher rather than a file list:
 * with no query typed, the honest answer to "which file do you want" is the one
 * you were in a moment ago. `closed` is the answer to shutting a tab you needed,
 * which every editor answers and this one did not.
 */

const editor = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activePath: null,
    splitPath: null,
    recent: [],
    closed: [],
  });
});

describe('the recent list', () => {
  it('records a file when it is opened', () => {
    editor().openTab('src/a.ts');

    expect(editor().recent).toEqual(['src/a.ts']);
  });

  it('puts the newest first', () => {
    editor().openTab('a.ts');
    editor().openTab('b.ts');
    editor().openTab('c.ts');

    expect(editor().recent).toEqual(['c.ts', 'b.ts', 'a.ts']);
  });

  it('moves a file back to the front rather than listing it twice', () => {
    editor().openTab('a.ts');
    editor().openTab('b.ts');
    editor().openTab('a.ts');

    expect(editor().recent).toEqual(['a.ts', 'b.ts']);
  });

  it('counts switching to an already-open tab as using it', () => {
    editor().openTab('a.ts');
    editor().openTab('b.ts');

    editor().setActive('a.ts');

    expect(editor().recent[0]).toBe('a.ts');
  });

  it('stays bounded over a long session', () => {
    for (let i = 0; i < MAX_RECENT + 15; i++) editor().openTab(`f${i}.ts`);

    expect(editor().recent).toHaveLength(MAX_RECENT);
    // The cap drops the oldest, never the newest.
    expect(editor().recent[0]).toBe(`f${MAX_RECENT + 14}.ts`);
  });

  it('holds paths and nothing else', () => {
    editor().openTab('src/secret-looking.ts');

    expect(editor().recent.every((entry) => typeof entry === 'string')).toBe(true);
    expect(JSON.stringify(editor().recent)).toBe('["src/secret-looking.ts"]');
  });
});

describe('reopening a closed editor', () => {
  it('gives back the file that was just closed', () => {
    editor().openTab('a.ts');
    editor().closeTab('a.ts');

    expect(editor().reopenClosed()).toBe('a.ts');
  });

  it('works backwards through several closes', () => {
    editor().openTab('a.ts');
    editor().openTab('b.ts');
    editor().closeTab('a.ts');
    editor().closeTab('b.ts');

    expect(editor().reopenClosed()).toBe('b.ts');
    expect(editor().reopenClosed()).toBe('a.ts');
  });

  it('answers null when nothing has been closed', () => {
    expect(editor().reopenClosed()).toBeNull();
  });

  it('consumes the entry, so a second call does not repeat it', () => {
    editor().openTab('a.ts');
    editor().closeTab('a.ts');

    editor().reopenClosed();

    expect(editor().reopenClosed()).toBeNull();
  });

  it('does not list the same path twice after closing it twice', () => {
    editor().openTab('a.ts');
    editor().closeTab('a.ts');
    editor().openTab('a.ts');
    editor().closeTab('a.ts');

    expect(editor().closed).toEqual(['a.ts']);
  });

  it('stays bounded', () => {
    for (let i = 0; i < MAX_CLOSED + 10; i++) {
      editor().openTab(`f${i}.ts`);
      editor().closeTab(`f${i}.ts`);
    }

    expect(editor().closed).toHaveLength(MAX_CLOSED);
  });
});

describe('closing to the right', () => {
  const open = (...paths: string[]) => paths.forEach((path) => editor().openTab(path));

  it('closes only what comes after', () => {
    open('a.ts', 'b.ts', 'c.ts', 'd.ts');

    editor().closeToRight('b.ts');

    expect(editor().tabs.map((tab) => tab.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps pinned tabs, as every other close does', () => {
    open('a.ts', 'b.ts', 'c.ts');
    editor().togglePin('c.ts');

    editor().closeToRight('a.ts');

    expect(editor().tabs.map((tab) => tab.path)).toEqual(['a.ts', 'c.ts']);
  });

  it('leaves an active tab that survived alone', () => {
    open('a.ts', 'b.ts', 'c.ts');
    editor().setActive('a.ts');

    editor().closeToRight('b.ts');

    expect(editor().activePath).toBe('a.ts');
  });

  it('moves focus to the anchor when the active tab was closed', () => {
    open('a.ts', 'b.ts', 'c.ts');
    editor().setActive('c.ts');

    editor().closeToRight('a.ts');

    expect(editor().activePath).toBe('a.ts');
  });

  it('offers the closed files for reopening', () => {
    open('a.ts', 'b.ts', 'c.ts');

    editor().closeToRight('a.ts');

    expect(editor().closed).toContain('b.ts');
    expect(editor().closed).toContain('c.ts');
  });

  it('does nothing for the last tab', () => {
    open('a.ts', 'b.ts');

    editor().closeToRight('b.ts');

    expect(editor().tabs.map((tab) => tab.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('clears a split that pointed at a closed tab', () => {
    open('a.ts', 'b.ts');
    editor().setSplit('b.ts');

    editor().closeToRight('a.ts');

    expect(editor().splitPath).toBeNull();
  });
});

describe('coming back to a project', () => {
  const savedSession = () => {
    useEditorStore.setState({
      sessions: {
        p1: {
          tabs: [{ path: 'a.ts', pinned: false }, { path: 'b.ts', pinned: false }],
          activePath: 'b.ts',
          cursors: {},
        },
      },
    });
  };

  it('seeds the recent list from the restored tabs, active file first', () => {
    savedSession();

    useEditorStore.getState().restoreSession('p1', () => true);

    // Returning is exactly when "the file I was just in" matters most, and it
    // is also when nothing has been opened yet.
    expect(useEditorStore.getState().recent).toEqual(['b.ts', 'a.ts']);
  });

  it('does not resurrect tabs closed before the reload', () => {
    useEditorStore.setState({ closed: ['old.ts'] });
    savedSession();

    useEditorStore.getState().restoreSession('p1', () => true);

    expect(useEditorStore.getState().closed).toEqual([]);
    expect(useEditorStore.getState().reopenClosed()).toBeNull();
  });

  it('leaves the histories alone when there is nothing to restore', () => {
    useEditorStore.setState({ sessions: {}, recent: ['kept.ts'] });

    expect(useEditorStore.getState().restoreSession('missing', () => true)).toBe(false);
    expect(useEditorStore.getState().recent).toEqual(['kept.ts']);
  });

  it('seeds only files the project still has', () => {
    savedSession();

    useEditorStore.getState().restoreSession('p1', (path) => path === 'b.ts');

    expect(useEditorStore.getState().recent).toEqual(['b.ts']);
  });
});
