import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorTab } from '@/types';

interface EditorState {
  openTabs: EditorTab[];
  activeFileId: string | null;
  fileContents: Record<string, string>;
  openFile: (fileId: string, content: string) => void;
  closeTab: (fileId: string) => void;
  setActiveFile: (fileId: string) => void;
  updateContent: (fileId: string, content: string) => void;
  markClean: (fileId: string) => void;
  getActiveTab: () => EditorTab | null;
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      openTabs: [],
      activeFileId: null,
      fileContents: {},

      openFile: (fileId, content) =>
        set((state) => {
          const existing = state.openTabs.find((t) => t.fileId === fileId);
          if (existing) {
            return { activeFileId: fileId };
          }
          return {
            openTabs: [...state.openTabs, { fileId, dirty: false }],
            activeFileId: fileId,
            fileContents: { ...state.fileContents, [fileId]: content },
          };
        }),

      closeTab: (fileId) =>
        set((state) => {
          const tabs = state.openTabs.filter((t) => t.fileId !== fileId);
          const activeFileId =
            state.activeFileId === fileId
              ? tabs.length > 0
                ? tabs[tabs.length - 1].fileId
                : null
              : state.activeFileId;
          const fileContents = { ...state.fileContents };
          delete fileContents[fileId];
          return { openTabs: tabs, activeFileId, fileContents };
        }),

      setActiveFile: (fileId) => set({ activeFileId: fileId }),

      updateContent: (fileId, content) =>
        set((state) => ({
          fileContents: { ...state.fileContents, [fileId]: content },
          openTabs: state.openTabs.map((t) =>
            t.fileId === fileId ? { ...t, dirty: true } : t
          ),
        })),

      markClean: (fileId) =>
        set((state) => ({
          openTabs: state.openTabs.map((t) =>
            t.fileId === fileId ? { ...t, dirty: false } : t
          ),
        })),

      getActiveTab: () => {
        const { openTabs, activeFileId } = get();
        return openTabs.find((t) => t.fileId === activeFileId) ?? null;
      },
    }),
    { name: 'codespace-editor' }
  )
);
