import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorTab, Problem } from '@/types';

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

  openTab: (path: string) => void;
  closeTab: (path: string) => void;
  closeOthers: (path: string) => void;
  closeAll: () => void;
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

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activePath: null,
  cursor: { line: 1, column: 1 },
  problems: [],
  reveal: null,
  splitPath: null,

  openTab: (path) =>
    set((state) => {
      if (state.tabs.some((tab) => tab.path === path)) return { activePath: path };
      return { tabs: [...state.tabs, { path, pinned: false }], activePath: path };
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
      };
    }),

  closeOthers: (path) =>
    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.path === path || tab.pinned),
      activePath: path,
    })),

  closeAll: () => set({ tabs: [], activePath: null, splitPath: null }),

  setActive: (path) => set({ activePath: path }),

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
    },
  ),
);
