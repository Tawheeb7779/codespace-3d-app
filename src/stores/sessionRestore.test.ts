import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '@/stores/editorStore';

/**
 * Restored sessions are untrusted input.
 *
 * This is the one persisted slice that decides which files the editor opens,
 * and it lives in browser storage where anything can write to it. So the merge
 * step re-validates every path through the same rules the file system uses,
 * and drops what fails rather than repairing it — a lost session is always
 * better than an honoured bad one.
 *
 * These drive the store's own `merge`, which is what runs on a real reload.
 */

type Merge = (persisted: unknown, current: unknown) => { sessions: Record<string, unknown> };

/** The persist option the store was created with, reached through its API. */
const merge = (useEditorStore.persist.getOptions().merge ?? ((p, c) => ({ ...(c as object), ...(p as object) }))) as Merge;

const restored = (sessions: unknown) =>
  merge({ sessions }, useEditorStore.getState()).sessions as Record<
    string,
    { tabs: { path: string; pinned: boolean }[]; activePath: string; cursors: Record<string, unknown> }
  >;

beforeEach(() => {
  useEditorStore.setState({ sessions: {} });
});

describe('a well-formed session', () => {
  it('survives intact', () => {
    const sessions = restored({
      p1: {
        tabs: [
          { path: 'src/a.ts', pinned: true },
          { path: 'src/b.ts', pinned: false },
        ],
        activePath: 'src/b.ts',
        cursors: { 'src/b.ts': { line: 12, column: 3 } },
      },
    });
    expect(sessions.p1.tabs).toEqual([
      { path: 'src/a.ts', pinned: true },
      { path: 'src/b.ts', pinned: false },
    ]);
    expect(sessions.p1.activePath).toBe('src/b.ts');
    expect(sessions.p1.cursors['src/b.ts']).toEqual({ line: 12, column: 3 });
  });
});

describe('paths that must never be reopened', () => {
  it('drops traversal and absolute paths', () => {
    for (const path of ['../../etc/passwd', '/etc/passwd', 'src/../../out.ts', '..\\..\\win']) {
      const sessions = restored({ p1: { tabs: [{ path, pinned: false }], activePath: path } });
      expect(sessions.p1, path).toBeUndefined();
    }
  });

  it('drops protected paths', () => {
    for (const path of ['.env', '.git/config', 'node_modules/x/index.js', '.ssh/id_rsa']) {
      const sessions = restored({ p1: { tabs: [{ path, pinned: false }], activePath: path } });
      expect(sessions.p1, path).toBeUndefined();
    }
  });

  it('keeps the good tabs when only some are bad', () => {
    const sessions = restored({
      p1: {
        tabs: [
          { path: 'src/ok.ts', pinned: false },
          { path: '../escape.ts', pinned: false },
          { path: '.env', pinned: false },
        ],
        activePath: '../escape.ts',
      },
    });
    expect(sessions.p1.tabs.map((tab) => tab.path)).toEqual(['src/ok.ts']);
    // The active path pointed at a dropped tab, so it falls back to a real one.
    expect(sessions.p1.activePath).toBe('src/ok.ts');
  });
});

describe('corrupted storage', () => {
  it('survives every shape that is not a session map', () => {
    for (const bad of [null, undefined, 'string', 42, [], { p1: null }, { p1: 'nope' }]) {
      expect(() => restored(bad)).not.toThrow();
      expect(Object.keys(restored(bad))).toEqual([]);
    }
  });

  it('drops a session with no usable tabs rather than storing an empty one', () => {
    expect(restored({ p1: { tabs: [], activePath: 'src/a.ts' } }).p1).toBeUndefined();
    expect(restored({ p1: { tabs: 'not an array' } }).p1).toBeUndefined();
  });

  /** A stored NaN would reach `revealLine` and break the editor. */
  it('refuses a caret that is not a real position', () => {
    const sessions = restored({
      p1: {
        tabs: [{ path: 'src/a.ts', pinned: false }],
        activePath: 'src/a.ts',
        cursors: {
          'src/a.ts': { line: Number.NaN, column: 1 },
        },
      },
    });
    expect(sessions.p1.cursors['src/a.ts']).toBeUndefined();

    for (const caret of [{ line: 0, column: 1 }, { line: 1, column: -5 }, { line: 'x', column: 1 }]) {
      const one = restored({
        p1: {
          tabs: [{ path: 'src/a.ts', pinned: false }],
          activePath: 'src/a.ts',
          cursors: { 'src/a.ts': caret },
        },
      });
      expect(one.p1.cursors['src/a.ts'], JSON.stringify(caret)).toBeUndefined();
    }
  });

  it('ignores a caret for a file that is not open', () => {
    const sessions = restored({
      p1: {
        tabs: [{ path: 'src/a.ts', pinned: false }],
        activePath: 'src/a.ts',
        cursors: { 'src/other.ts': { line: 4, column: 1 } },
      },
    });
    expect(sessions.p1.cursors).toEqual({});
  });

  it('coerces a non-boolean pin rather than storing it', () => {
    const sessions = restored({
      p1: { tabs: [{ path: 'src/a.ts', pinned: 'yes' }], activePath: 'src/a.ts' },
    });
    expect(sessions.p1.tabs[0].pinned).toBe(false);
  });

  it('bounds how much a hand-edited store can reopen', () => {
    const tabs = Array.from({ length: 500 }, (_, i) => ({ path: `src/f${i}.ts`, pinned: false }));
    const sessions = restored({ p1: { tabs, activePath: 'src/f0.ts' } });
    expect(sessions.p1.tabs.length).toBeLessThanOrEqual(60);
  });
});
