import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorTab, Problem } from '@/types';
import { MAX_PATH_LENGTH, isSensitivePath, normalizePath } from '@/lib/vfs';

export interface PendingReveal {
  path: string;
  line: number;
  column: number;
  token: number;
}

/** What a reload should be able to put back for one project. */
export interface EditorSession {
  tabs: EditorTab[];
  activePath: string | null;
  /** Last known caret position per file, so a reopened file lands where you left it. */
  cursors: Record<string, { line: number; column: number }>;
}

/**
 * How many paths each history keeps.
 *
 * Small on purpose. These exist to answer "what was I just in", and a list long
 * enough to need scrolling has stopped answering that. Bounded also means the
 * persisted blob cannot grow without limit over a long-lived project.
 */
export const MAX_RECENT = 20;
export const MAX_CLOSED = 20;

/** Move a path to the front, without duplicating it. */
function touch(list: string[], path: string): string[] {
  return [path, ...list.filter((entry) => entry !== path)].slice(0, MAX_RECENT);
}

/** Same, for the closed-tab history. */
function remember(list: string[], path: string): string[] {
  return [path, ...list.filter((entry) => entry !== path)].slice(0, MAX_CLOSED);
}

/** Sessions older than this are dropped rather than kept forever. */
export const MAX_REMEMBERED_PROJECTS = 12;

interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  /** Cursor position of the focused editor, shown in the status bar. */
  cursor: { line: number; column: number };
  problems: Problem[];
  /** Set when something outside the editor asks it to jump to a location. */
  reveal: PendingReveal | null;
  splitPath: string | null;
  /**
   * Paths in the order they were last looked at, newest first.
   *
   * Paths only — never content — so this can never carry code or a secret into
   * storage. Bounded, because its whole job is "the handful you were just in".
   */
  recent: string[];
  /**
   * Files closed in this session, newest first, for reopening.
   *
   * Also paths only. A closed tab is cheap to restore because the file itself
   * was never the tab: closing has always been a view action here, not a
   * discard, so reopening cannot resurrect stale content.
   */
  closed: string[];

  openTab: (path: string) => void;
  closeTab: (path: string) => void;
  closeOthers: (path: string) => void;
  closeAll: () => void;
  /** Close every tab whose file has nothing unsaved, keeping pinned ones. */
  closeSaved: (isDirty: (path: string) => boolean) => void;
  /** Close every tab to the right of this one, keeping pinned ones. */
  closeToRight: (path: string) => void;
  /** Reopen the most recently closed file. Returns the path, or null. */
  reopenClosed: () => string | null;
  setActive: (path: string) => void;
  reorder: (from: number, to: number) => void;
  togglePin: (path: string) => void;
  renamePath: (from: string, to: string) => void;
  removePath: (path: string) => void;
  setCursor: (line: number, column: number) => void;
  setProblems: (problems: Problem[]) => void;
  revealLocation: (path: string, line: number, column?: number) => void;
  consumeReveal: () => void;
  setSplit: (path: string | null) => void;

  /** Persisted per project; only these survive a reload. */
  sessions: Record<string, EditorSession>;
  rememberSession: (projectId: string) => void;
  restoreSession: (projectId: string, exists: (path: string) => boolean) => boolean;
  forgetSession: (projectId: string) => void;
}

/**
 * File the "Split editor" button should show beside the active one.
 *
 * The side pane only renders a path it can name, so returning the active path
 * when another tab is available left the button lit with an empty pane.
 */
export function splitTargetFor(tabs: EditorTab[], activePath: string | null): string | null {
  if (!tabs.length) return null;
  const index = tabs.findIndex((tab) => tab.path === activePath);
  if (index === -1) return tabs[0].path;
  return (tabs[index + 1] ?? tabs[index - 1])?.path ?? activePath;
}

/** A path is only restorable if it is one the file system would accept. */
function usablePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH) return false;
  try {
    // `normalizePath` throws on traversal and absolute paths; a stored path
    // that does not survive it unchanged was not written by this app.
    return normalizePath(value) === value && !isSensitivePath(value);
  } catch {
    return false;
  }
}

function sanitiseSessions(value: unknown): Record<string, EditorSession> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, EditorSession> = {};
  for (const [projectId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof projectId !== 'string' || !raw || typeof raw !== 'object') continue;
    const session = raw as Partial<EditorSession>;

    const tabs = Array.isArray(session.tabs)
      ? session.tabs
          .filter((tab): tab is EditorTab => Boolean(tab) && usablePath((tab as EditorTab).path))
          .map((tab) => ({ path: tab.path, pinned: tab.pinned === true }))
          .slice(0, 60)
      : [];
    if (!tabs.length) continue;

    const open = new Set(tabs.map((tab) => tab.path));
    const cursors: EditorSession['cursors'] = {};
    for (const [path, caret] of Object.entries(session.cursors ?? {})) {
      if (!open.has(path) || !caret || typeof caret !== 'object') continue;
      const line = Number((caret as { line?: unknown }).line);
      const column = Number((caret as { column?: unknown }).column);
      // A caret outside the document is not restored; the editor would clamp
      // it anyway, and a stored NaN would reach `revealLine`.
      if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) continue;
      cursors[path] = { line: Math.floor(line), column: Math.floor(column) };
    }

    const activePath =
      typeof session.activePath === 'string' && open.has(session.activePath)
        ? session.activePath
        : tabs[0].path;

    out[projectId] = { tabs, activePath, cursors };
  }
  // Bound the map, in case storage grew beyond what the app would have written.
  return Object.fromEntries(Object.entries(out).slice(-MAX_REMEMBERED_PROJECTS));
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activePath: null,
  cursor: { line: 1, column: 1 },
  problems: [],
  reveal: null,
  splitPath: null,
  recent: [],
  closed: [],

  openTab: (path) =>
    set((state) => {
      const recent = touch(state.recent, path);
      if (state.tabs.some((tab) => tab.path === path)) return { activePath: path, recent };
      return { tabs: [...state.tabs, { path, pinned: false }], activePath: path, recent };
    }),

  closeTab: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.path !== path);
      let activePath = state.activePath;
      if (state.activePath === path) {
        // Focus the neighbour, preferring the tab to the left.
        activePath = tabs[Math.max(0, index - 1)]?.path ?? null;
      }
      return {
        tabs,
        activePath,
        splitPath: state.splitPath === path ? null : state.splitPath,
        closed: remember(state.closed, path),
      };
    }),

  /**
   * Close everything after this tab.
   *
   * The counterpart to "close others" for the common case of having opened a
   * trail of files chasing something down and wanting the trail gone. Pinned
   * tabs survive, as they do everywhere else.
   */
  closeToRight: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      if (index === -1) return state;
      const dropped = state.tabs.slice(index + 1).filter((tab) => !tab.pinned);
      if (!dropped.length) return state;
      const tabs = state.tabs.filter((tab, at) => at <= index || tab.pinned);
      const activePath = tabs.some((tab) => tab.path === state.activePath)
        ? state.activePath
        : path;
      return {
        tabs,
        activePath,
        splitPath: tabs.some((tab) => tab.path === state.splitPath) ? state.splitPath : null,
        closed: dropped.reduce((list, tab) => remember(list, tab.path), state.closed),
      };
    }),

  /**
   * Put back the file you just closed.
   *
   * Returns the path so the caller can react — the workspace has to check the
   * file still exists before reopening a tab onto nothing, and only it knows.
   */
  reopenClosed: () => {
    const [path, ...rest] = get().closed;
    if (!path) return null;
    set({ closed: rest });
    return path;
  },

  closeOthers: (path) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.path === path || tab.pinned);
      return {
        tabs,
        activePath: path,
        // The side pane only renders a path that still has a tab; leaving it
        // pointing at a closed one lit the split button over an empty pane.
        splitPath: tabs.some((tab) => tab.path === state.splitPath) ? state.splitPath : null,
      };
    }),

  closeAll: () => set({ tabs: [], activePath: null, splitPath: null }),

  /**
   * Close everything with nothing unsaved in it.
   *
   * Tab state and file content are separate here — closing a tab never discards
   * an edit, it just stops showing it — so this is a tidying action rather than
   * a destructive one, and it is the reason no close asks for confirmation.
   * Pinned tabs stay, as they do for "close others".
   */
  closeSaved: (isDirty) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.pinned || isDirty(tab.path));
      const activePath = tabs.some((tab) => tab.path === state.activePath)
        ? state.activePath
        : (tabs[0]?.path ?? null);
      return {
        tabs,
        activePath,
        splitPath: tabs.some((tab) => tab.path === state.splitPath) ? state.splitPath : null,
      };
    }),

  setActive: (path) => set((state) => ({ activePath: path, recent: touch(state.recent, path) })),

  reorder: (from, to) =>
    set((state) => {
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!moved) return state;
      tabs.splice(to, 0, moved);
      return { tabs };
    }),

  togglePin: (path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, pinned: !tab.pinned } : tab)),
    })),

  renamePath: (from, to) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === from
          ? { ...tab, path: to }
          : tab.path.startsWith(`${from}/`)
            ? { ...tab, path: to + tab.path.slice(from.length) }
            : tab,
      ),
      activePath:
        state.activePath === from
          ? to
          : state.activePath?.startsWith(`${from}/`)
            ? to + state.activePath.slice(from.length)
            : state.activePath,
    })),

  removePath: (path) => {
    const affected = get().tabs.filter(
      (tab) => tab.path === path || tab.path.startsWith(`${path}/`),
    );
    affected.forEach((tab) => get().closeTab(tab.path));
  },

  setCursor: (line, column) => set({ cursor: { line, column } }),
  setProblems: (problems) => set({ problems }),

  revealLocation: (path, line, column = 1) =>
    set((state) => ({
      tabs: state.tabs.some((tab) => tab.path === path)
        ? state.tabs
        : [...state.tabs, { path, pinned: false }],
      activePath: path,
      reveal: { path, line, column, token: Date.now() },
    })),

  consumeReveal: () => set({ reveal: null }),
  setSplit: (path) => set({ splitPath: path }),

  sessions: {},

  rememberSession: (projectId) =>
    set((state) => {
      const previous = state.sessions[projectId];
      const cursors = { ...previous?.cursors };
      if (state.activePath) cursors[state.activePath] = state.cursor;
      // Keep only cursors for files still open, so the record cannot grow
      // without bound as files come and go.
      const open = new Set(state.tabs.map((tab) => tab.path));
      for (const path of Object.keys(cursors)) {
        if (!open.has(path)) delete cursors[path];
      }

      const sessions = { ...state.sessions, [projectId]: { tabs: state.tabs, activePath: state.activePath, cursors } };
      const ids = Object.keys(sessions);
      if (ids.length > MAX_REMEMBERED_PROJECTS) {
        for (const id of ids.slice(0, ids.length - MAX_REMEMBERED_PROJECTS)) {
          if (id !== projectId) delete sessions[id];
        }
      }
      return { sessions };
    }),

  /**
   * Put back what was open, dropping anything the project no longer has.
   *
   * Returns whether anything was restored, so the caller can fall back to
   * opening a sensible first file instead.
   */
  restoreSession: (projectId, exists) => {
    const saved = get().sessions[projectId];
    if (!saved) return false;
    const tabs = saved.tabs.filter((tab) => exists(tab.path));
    if (!tabs.length) return false;
    const activePath =
      saved.activePath && tabs.some((tab) => tab.path === saved.activePath)
        ? saved.activePath
        : tabs[0].path;
    const caret = saved.cursors[activePath];
    set({
      tabs,
      activePath,
      splitPath: null,
      cursor: caret ?? { line: 1, column: 1 },
      reveal: caret ? { path: activePath, line: caret.line, column: caret.column, token: Date.now() } : null,
      /*
       * Seed the recent list from the session being restored.
       *
       * Coming back to a project is exactly when "the file I was just in" is
       * most useful, and it is also when nothing has been opened yet — so
       * without this, quick open would offer an arbitrary slice of the project
       * to someone whose tabs had just been put back in front of them. The
       * active file leads because it is the one they left off in.
       *
       * `closed` is deliberately not restored: a tab closed before a reload is
       * not something Ctrl+Shift+T should resurrect a day later.
       */
      recent: [activePath, ...tabs.map((tab) => tab.path).filter((path) => path !== activePath)]
        .slice(0, MAX_RECENT),
      closed: [],
    });
    return true;
  },

  forgetSession: (projectId) =>
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[projectId];
      return { sessions };
    }),
}),
    {
      name: 'forge.editor',
      // Only the session map persists: live tabs, problems and reveals belong
      // to the open project and are rebuilt from it.
      partialize: (state) => ({ sessions: state.sessions }),
      /**
       * Treat stored sessions as untrusted input.
       *
       * This is the one slice restored from browser storage that decides which
       * files the editor opens, so hand-edited or corrupted data must not be
       * able to reopen an arbitrary path. Every entry is re-validated through
       * the same path rules the file system uses, and anything that fails is
       * dropped rather than repaired — a session is a convenience, and losing
       * one is always better than honouring a bad one.
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as { sessions?: unknown };
        return { ...current, sessions: sanitiseSessions(saved.sessions) };
      },
    },
  ),
);
