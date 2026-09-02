import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarPanel = 'explorer' | 'search' | 'git' | 'packages' | 'assistant' | 'members';
export type BottomTab = 'terminal' | 'problems' | 'output' | 'ports';
export type MobilePane = 'files' | 'editor' | 'preview' | 'terminal' | 'assistant';

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
  mobilePane: MobilePane;
  mobileDrawerOpen: boolean;

  setSidebarPanel: (panel: SidebarPanel) => void;
  toggleSidebar: (open?: boolean) => void;
  setSidebarWidth: (width: number) => void;
  togglePreview: (open?: boolean) => void;
  setPreviewWidth: (width: number) => void;
  toggleBottom: (open?: boolean) => void;
  setBottomHeight: (height: number) => void;
  setBottomTab: (tab: BottomTab) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  setMobilePane: (pane: MobilePane) => void;
  setMobileDrawerOpen: (open: boolean) => void;
  resetLayout: () => void;
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
      mobilePane: 'editor',
      mobileDrawerOpen: false,

      setSidebarPanel: (panel) =>
        set((state) => ({
          sidebarPanel: panel,
          // Clicking the active icon collapses the panel, as in VS Code.
          sidebarOpen: state.sidebarPanel === panel ? !state.sidebarOpen : true,
        })),
      toggleSidebar: (open) => set((state) => ({ sidebarOpen: open ?? !state.sidebarOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: clamp(width, 200, 520) }),
      togglePreview: (open) => set((state) => ({ previewOpen: open ?? !state.previewOpen })),
      setPreviewWidth: (width) => set({ previewWidth: clamp(width, 280, 900) }),
      toggleBottom: (open) => set((state) => ({ bottomOpen: open ?? !state.bottomOpen })),
      setBottomHeight: (height) => set({ bottomHeight: clamp(height, 120, 640) }),
      setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open, quickOpenOpen: false }),
      setQuickOpenOpen: (open) => set({ quickOpenOpen: open, commandPaletteOpen: false }),
      setMobilePane: (pane) => set({ mobilePane: pane, mobileDrawerOpen: false }),
      setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),
      resetLayout: () => set(DEFAULTS),
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
      }),
    },
  ),
);
