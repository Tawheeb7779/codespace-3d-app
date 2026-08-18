import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { X } from 'lucide-react';

export function EditorTabs() {
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeTab = useEditorStore((s) => s.closeTab);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);
  const activeProject = useProjectStore((s) => s.getActiveProject());

  if (!activeProject) return null;

  return (
    <div className="flex items-center h-9 border-b border-outline-variant/10 overflow-x-auto shrink-0">
      {openTabs.map((tab) => {
        const file = activeProject.files.find((f) => f.id === tab.fileId);
        if (!file) return null;
        const isActive = activeFileId === tab.fileId;
        return (
          <div
            key={tab.fileId}
            onClick={() => setActiveFile(tab.fileId)}
            className={`group flex items-center gap-2 px-3 h-full cursor-pointer border-r border-outline-variant/10 transition-colors ${
              isActive
                ? 'bg-surface-low text-on-surface border-t-2 border-t-primary'
                : 'text-on-surface-variant hover:bg-white/5'
            }`}
          >
            <span className="text-xs font-mono truncate max-w-[120px]">{file.name}</span>
            {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.fileId);
              }}
              className="p-0.5 rounded hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
