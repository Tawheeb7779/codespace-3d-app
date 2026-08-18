import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorTab, CenterView, BottomTab, ViewMode } from '@/types';

interface UIState {
  // Navigation
  currentView: ViewMode;
  setView: (view: ViewMode) => void;

  // Panel visibility
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  bottomPanelOpen: boolean;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleBottomPanel: () => void;

  // Panel sizes (percentages)
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  bottomPanelHeight: number;
  setLeftSidebarWidth: (w: number) => void;
  setRightSidebarWidth: (w: number) => void;
  setBottomPanelHeight: (h: number) => void;

  // Center view
  centerView: CenterView;
  setCenterView: (view: CenterView) => void;

  // Bottom panel tab
  bottomTab: BottomTab;
  setBottomTab: (tab: BottomTab) => void;

  // File explorer
  fileExplorerOpen: boolean;
  toggleFileExplorer: () => void;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // Mobile
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;

  // Preview
  previewSize: 'desktop' | 'tablet' | 'mobile';
  setPreviewSize: (size: 'desktop' | 'tablet' | 'mobile') => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      currentView: 'dashboard',
      setView: (view) => set({ currentView: view }),

      leftSidebarOpen: true,
      rightSidebarOpen: true,
      bottomPanelOpen: true,
      toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
      toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
      toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),

      leftSidebarWidth: 260,
      rightSidebarWidth: 280,
      bottomPanelHeight: 220,
      setLeftSidebarWidth: (w) => set({ leftSidebarWidth: Math.max(180, Math.min(400, w)) }),
      setRightSidebarWidth: (w) => set({ rightSidebarWidth: Math.max(200, Math.min(420, w)) }),
      setBottomPanelHeight: (h) => set({ bottomPanelHeight: Math.max(100, Math.min(500, h)) }),

      centerView: 'editor',
      setCenterView: (view) => set({ centerView: view }),

      bottomTab: 'terminal',
      setBottomTab: (tab) => set({ bottomTab: tab }),

      fileExplorerOpen: true,
      toggleFileExplorer: () => set((s) => ({ fileExplorerOpen: !s.fileExplorerOpen })),

      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

      mobileNavOpen: false,
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),

      previewSize: 'desktop',
      setPreviewSize: (size) => set({ previewSize: size }),
    }),
    {
      name: 'codespace-ui',
      partialize: (s) => ({
        leftSidebarWidth: s.leftSidebarWidth,
        rightSidebarWidth: s.rightSidebarWidth,
        bottomPanelHeight: s.bottomPanelHeight,
        previewSize: s.previewSize,
      }),
    }
  )
);
