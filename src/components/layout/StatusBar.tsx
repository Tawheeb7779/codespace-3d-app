import { useProjectStore } from '@/stores/projectStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStore } from '@/stores/uiStore';
import { GitBranch, Check, AlertCircle, Wifi, Cpu } from 'lucide-react';

export function StatusBar() {
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const openTabs = useEditorStore((s) => s.openTabs);
  const dirtyCount = openTabs.filter((t) => t.dirty).length;
  const { currentView } = useUIStore();

  return (
    <footer className="h-6 bg-surface-lowest border-t border-outline-variant/10 flex items-center justify-between px-3 text-[11px] font-mono text-on-surface-variant shrink-0 z-30">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1 text-success">
          <Check size={12} />
          <span>System: Optimal</span>
        </span>
        {activeProject && (
          <span className="flex items-center gap-1 text-secondary">
            <GitBranch size={11} />
            <span>main</span>
          </span>
        )}
        {dirtyCount > 0 && (
          <span className="flex items-center gap-1 text-tertiary">
            <AlertCircle size={11} />
            <span>{dirtyCount} unsaved</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden sm:flex items-center gap-1">
          <Wifi size={11} className="text-success" />
          <span>Connected</span>
        </span>
        <span className="hidden sm:flex items-center gap-1">
          <Cpu size={11} />
          <span>60 FPS</span>
        </span>
        <span className="text-outline">UTF-8</span>
        <span className="text-outline">Spaces: 2</span>
        <span className="text-outline hidden sm:inline">{currentView}</span>
      </div>
    </footer>
  );
}
