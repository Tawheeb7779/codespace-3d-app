import { useUIStore } from '@/stores/uiStore';
import { useProjectStore } from '@/stores/projectStore';
import { useResize } from '@/hooks/useResize';
import { FileExplorer } from './FileExplorer';
import { CodeEditor } from './CodeEditor';
import { SceneViewport } from './SceneViewport';
import { LivePreview } from './LivePreview';
import { Inspector } from './Inspector';
import { BottomPanel } from './BottomPanel';
import { EmptyState } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Code, Box, Eye, PanelLeft, PanelRight, PanelBottom } from 'lucide-react';

export function Workspace() {
  const {
    leftSidebarOpen, rightSidebarOpen, bottomPanelOpen,
    toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel,
    leftSidebarWidth, rightSidebarWidth, bottomPanelHeight,
    setLeftSidebarWidth, setRightSidebarWidth, setBottomPanelHeight,
    centerView, setCenterView,
  } = useUIStore();
  const activeProject = useProjectStore((s) => s.getActiveProject());

  const leftResize = useResize({
    direction: 'horizontal',
    onResize: (delta) => setLeftSidebarWidth(leftSidebarWidth + delta),
  });
  const rightResize = useResize({
    direction: 'horizontal',
    onResize: (delta) => setRightSidebarWidth(rightSidebarWidth - delta),
  });
  const bottomResize = useResize({
    direction: 'vertical',
    onResize: (delta) => setBottomPanelHeight(bottomPanelHeight - delta),
  });

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Box size={48} />}
          title="No Active Project"
          message="Create or select a project to start working in the workspace."
          action={<Button variant="primary" onClick={() => useUIStore.getState().setView('projects')}>Browse Projects</Button>}
        />
      </div>
    );
  }

  const centerViews = [
    { id: 'editor' as const, icon: Code, label: 'Editor' },
    { id: 'scene' as const, icon: Box, label: '3D Scene' },
    { id: 'preview' as const, icon: Eye, label: 'Preview' },
  ];

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left sidebar - File Explorer */}
      {leftSidebarOpen && (
        <>
          <div style={{ width: leftSidebarWidth }} className="shrink-0 glass-panel border-r border-outline-variant/10 flex flex-col">
            <FileExplorer />
          </div>
          <div onPointerDown={leftResize} className="resize-handle resize-handle-h w-1 bg-transparent hover:bg-primary/30 shrink-0 transition-colors" />
        </>
      )}

      {/* Center area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Center view tabs */}
        <div className="flex items-center justify-between px-2 py-1 border-b border-outline-variant/10 shrink-0">
          <div className="flex items-center gap-1">
            {centerViews.map((v) => {
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  onClick={() => setCenterView(v.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all ${
                    centerView === v.id
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <Icon size={13} />
                  {v.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={toggleLeftSidebar} className="p-1 rounded text-outline hover:text-on-surface transition-colors md:hidden">
              <PanelLeft size={14} />
            </button>
            <button onClick={toggleBottomPanel} className="p-1 rounded text-outline hover:text-on-surface transition-colors md:hidden">
              <PanelBottom size={14} />
            </button>
            <button onClick={toggleRightSidebar} className="p-1 rounded text-outline hover:text-on-surface transition-colors md:hidden">
              <PanelRight size={14} />
            </button>
          </div>
        </div>

        {/* Center content */}
        <div className="flex-1 overflow-hidden">
          {centerView === 'editor' && <CodeEditor />}
          {centerView === 'scene' && <SceneViewport />}
          {centerView === 'preview' && <LivePreview />}
        </div>

        {/* Bottom panel */}
        {bottomPanelOpen && (
          <>
            <div onPointerDown={bottomResize} className="resize-handle resize-handle-v h-1 bg-transparent hover:bg-primary/30 shrink-0 transition-colors" />
            <div style={{ height: bottomPanelHeight }} className="shrink-0 glass-panel border-t border-outline-variant/10">
              <BottomPanel />
            </div>
          </>
        )}
      </div>

      {/* Right sidebar - Inspector */}
      {rightSidebarOpen && (
        <>
          <div onPointerDown={rightResize} className="resize-handle resize-handle-h w-1 bg-transparent hover:bg-primary/30 shrink-0 transition-colors" />
          <div style={{ width: rightSidebarWidth }} className="shrink-0 glass-panel border-l border-outline-variant/10 flex flex-col">
            <Inspector />
          </div>
        </>
      )}
    </div>
  );
}
