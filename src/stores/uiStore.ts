import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarPanel =
  | 'project'
  | 'activity'
  | 'tasks'
  | 'explorer'
  | 'search'
  | 'git'
  | 'packages'
  | 'assistant'
  | 'comments'
  | 'security'
  | 'observability'
  | 'health'
  | 'api'
  | 'environments'
  | 'performance'
  | 'architecture'
  | 'timeline'
  | 'extensions'
  | 'members';
export type BottomTab = 'terminal' | 'problems' | 'checks' | 'output' | 'ports';
export type MobilePane = 'files' | 'editor' | 'preview' | 'terminal' | 'assistant';

/**
 * A named arrangement of the workspace.
 *
 * These are not new state — each one is a set of values for the panels that
 * already exist. What they add is the ability to say "I am debugging now"
 * in one keystroke instead of dragging four dividers, and to get back to
 * where you were afterwards.
 */
export type LayoutId = 'coding' | 'debugging' | 'ai' | 'preview' | 'git' | 'focus';

export interface LayoutPreset {
  id: LayoutId;
  label: string;
  description: string;
  /** What the panels look like in this arrangement. */
  apply: Pick<
    UIState,
    | 'sidebarPanel'
    | 'sidebarOpen'
    | 'previewOpen'
    | 'bottomOpen'
    | 'bottomTab'
  >;
}

export const LAYOUTS: LayoutPreset[] = [
  {
    id: 'coding',
    label: 'Coding',
    description: 'Files beside the editor, terminal below, preview to one side.',
    apply: {
      sidebarPanel: 'explorer',
      sidebarOpen: true,
      previewOpen: true,
      bottomOpen: true,
      bottomTab: 'terminal',
    },
  },
  {
    id: 'debugging',
    label: 'Debugging',
    description: 'Problems open and the preview visible, so a fix can be seen landing.',
    apply: {
      sidebarPanel: 'explorer',
      sidebarOpen: true,
      previewOpen: true,
      bottomOpen: true,
      bottomTab: 'problems',
    },
  },
  {
    id: 'ai',
    label: 'Assistant',
    description: 'The assistant beside the editor, with its output panel below.',
    apply: {
      sidebarPanel: 'assistant',
      sidebarOpen: true,
      previewOpen: false,
      bottomOpen: true,
      bottomTab: 'output',
    },
  },
  {
    id: 'preview',
    label: 'Preview',
    description: 'The running app takes the width; the tree steps out of the way.',
    apply: {
      sidebarPanel: 'explorer',
      sidebarOpen: false,
      previewOpen: true,
      bottomOpen: false,
      bottomTab: 'terminal',
    },
  },
  {
    id: 'git',
    label: 'Source control',
    description: 'Changes and history beside the diff.',
    apply: {
      sidebarPanel: 'git',
      sidebarOpen: true,
      previewOpen: false,
      bottomOpen: false,
      bottomTab: 'terminal',
    },
  },
  {
    id: 'focus',
    label: 'Focus',
    description: 'The editor and the status bar. Nothing else.',
    apply: {
      sidebarPanel: 'explorer',
      sidebarOpen: false,
      previewOpen: false,
      bottomOpen: false,
      bottomTab: 'terminal',
    },
  },
];

interface UIState {
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
  sidebarWidth: number;
  previewOpen: boolean;
  previewWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: BottomTab;
  commandPaletteOpen: boolean;
  quickOpenOpen: boolean;
  /**
   * A request from elsewhere — the command palette, a shortcut — for the panel
   * that owns the feature to start it. The owning panel clears the flag once
   * it has acted, so the logic stays in one place instead of being duplicated
   * into every caller.
   */
  pendingCreate: 'file' | 'folder' | null;
  searchWantsReplace: boolean;
  mobilePane: MobilePane;
  mobileDrawerOpen: boolean;
  /** The arrangement last chosen, so the workspace can say which one it is in. */
  layout: LayoutId | null;
  /**
   * What the panels looked like before focus mode, so leaving it puts them
   * back rather than guessing at a default the user never chose.
   */
  beforeFocus: LayoutPreset['apply'] | null;

  setSidebarPanel: (panel: SidebarPanel) => void;
  toggleSidebar: (open?: boolean) => void;
  setSidebarWidth: (width: number) => void;
  togglePreview: (open?: boolean) => void;
  setPreviewWidth: (width: number) => void;
  toggleBottom: (open?: boolean) => void;
  setBottomHeight: (height: number) => void;
  setBottomTab: (tab: BottomTab) => void;
  requestCreate: (kind: 'file' | 'folder') => void;
  consumeCreate: () => void;
  requestReplace: () => void;
  consumeReplace: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  setMobilePane: (pane: MobilePane) => void;
  setMobileDrawerOpen: (open: boolean) => void;
  resetLayout: () => void;
  applyLayout: (id: LayoutId) => void;
  toggleFocus: (on?: boolean) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const DEFAULTS = {
  sidebarPanel: 'explorer' as SidebarPanel,
  sidebarOpen: true,
  sidebarWidth: 264,
  previewOpen: true,
  previewWidth: 420,
  bottomOpen: true,
  bottomHeight: 240,
  bottomTab: 'terminal' as BottomTab,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      commandPaletteOpen: false,
      quickOpenOpen: false,
      pendingCreate: null,
      searchWantsReplace: false,
      mobilePane: 'editor',
      mobileDrawerOpen: false,
      layout: null,
      beforeFocus: null,

      /*
       * "Show me this panel" — expressed in whichever layout is on screen.
       *
       * The mobile workspace shows one pane at a time and reads `mobilePane`,
       * so setting only `sidebarPanel` there changed a pane nobody was looking
       * at: the status bar's "Open source control", and every palette command
       * that shows a panel, appeared to do nothing on a phone. Bringing the
       * matching pane forward here fixes all of those callers at once, rather
       * than asking each one to remember there are two layouts.
       */
      setSidebarPanel: (panel) =>
        set((state) => ({
          sidebarPanel: panel,
          // Clicking the active icon collapses the panel, as in VS Code.
          sidebarOpen: state.sidebarPanel === panel ? !state.sidebarOpen : true,
          // The assistant is its own pane on a phone; the rest live in Files.
          mobilePane: panel === 'assistant' ? 'assistant' : 'files',
        })),
      toggleSidebar: (open) => set((state) => ({ sidebarOpen: open ?? !state.sidebarOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: clamp(width, 200, 520) }),
      togglePreview: (open) => set((state) => ({ previewOpen: open ?? !state.previewOpen })),
      setPreviewWidth: (width) => set({ previewWidth: clamp(width, 280, 900) }),
      toggleBottom: (open) => set((state) => ({ bottomOpen: open ?? !state.bottomOpen })),
      setBottomHeight: (height) => set({ bottomHeight: clamp(height, 120, 640) }),
      // Same reasoning as setSidebarPanel: the bottom panel is the Terminal
      // pane on a phone, so "show me the problems" has to go there too.
      setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true, mobilePane: 'terminal' }),
      requestCreate: (kind) => set({ sidebarPanel: 'explorer', sidebarOpen: true, pendingCreate: kind }),
      consumeCreate: () => set({ pendingCreate: null }),
      requestReplace: () =>
        set({ sidebarPanel: 'search', sidebarOpen: true, searchWantsReplace: true }),
      consumeReplace: () => set({ searchWantsReplace: false }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open, quickOpenOpen: false }),
      setQuickOpenOpen: (open) => set({ quickOpenOpen: open, commandPaletteOpen: false }),
      setMobilePane: (pane) => set({ mobilePane: pane, mobileDrawerOpen: false }),
      setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),
      resetLayout: () => set({ ...DEFAULTS, layout: null, beforeFocus: null }),

      applyLayout: (id) => {
        const preset = LAYOUTS.find((entry) => entry.id === id);
        if (!preset) return;
        set({ ...preset.apply, layout: id, beforeFocus: null });
      },

      /**
       * Focus mode, and the way back out.
       *
       * Entering remembers the arrangement it replaced; leaving restores it.
       * Without that, the way out of focus mode is a guess, and a user who had
       * carefully arranged three panels loses them to a keystroke.
       */
      toggleFocus: (on) =>
        set((state) => {
          const focused = state.layout === 'focus';
          const next = on ?? !focused;
          if (next === focused) return state;
          if (next) {
            const focus = LAYOUTS.find((entry) => entry.id === 'focus');
            return {
              ...(focus?.apply ?? {}),
              layout: 'focus' as const,
              beforeFocus: {
                sidebarPanel: state.sidebarPanel,
                sidebarOpen: state.sidebarOpen,
                previewOpen: state.previewOpen,
                bottomOpen: state.bottomOpen,
                bottomTab: state.bottomTab,
              },
            };
          }
          const restored = state.beforeFocus ?? LAYOUTS[0].apply;
          return { ...restored, layout: null, beforeFocus: null };
        }),
    }),
    {
      name: 'forge.layout',
      // Persist geometry only — transient overlays must not reopen on reload.
      partialize: (state) => ({
        sidebarPanel: state.sidebarPanel,
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        previewOpen: state.previewOpen,
        previewWidth: state.previewWidth,
        bottomOpen: state.bottomOpen,
        bottomHeight: state.bottomHeight,
        bottomTab: state.bottomTab,
        layout: state.layout,
        beforeFocus: state.beforeFocus,
      }),
    },
  ),
);
