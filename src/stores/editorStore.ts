import { create } from 'zustand';
import type { EditorTab, Problem } from '@/types';

export interface PendingReveal {
  path: string;
  line: number;
  column: number;
  token: number;
}

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

export const useEditorStore = create<EditorState>()((set, get) => ({
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
}));
