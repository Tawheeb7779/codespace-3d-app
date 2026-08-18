import { useUIStore } from '@/stores/uiStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { Terminal } from '@/components/workspace/Terminal';
import { Tabs } from '@/components/ui/Tabs';
import { Terminal as TerminalIcon, AlertCircle, FileOutput, ScrollText } from 'lucide-react';

export function BottomPanel() {
  const { bottomTab, setBottomTab } = useUIStore();
  const terminalLines = useTerminalStore((s) => s.lines);

  const tabs = [
    { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={12} /> },
    { id: 'problems', label: 'Problems', icon: <AlertCircle size={12} /> },
    { id: 'output', label: 'Output', icon: <FileOutput size={12} /> },
    { id: 'logs', label: 'Logs', icon: <ScrollText size={12} /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1 border-b border-outline-variant/10 shrink-0">
        <Tabs items={tabs} activeId={bottomTab} onChange={setBottomTab} />
        <span className="text-[10px] font-mono text-outline">{terminalLines.length} lines</span>
      </div>
      <div className="flex-1 overflow-hidden">
        {bottomTab === 'terminal' && <Terminal />}
        {bottomTab === 'problems' && (
          <div className="flex items-center justify-center h-full text-xs text-outline">
            No problems detected
          </div>
        )}
        {bottomTab === 'output' && (
          <div className="p-2 font-mono text-xs text-on-surface-variant space-y-0.5">
            <div className="text-secondary">[INFO] Build started at {new Date().toLocaleTimeString()}</div>
            <div className="text-success">[SUCCESS] Build completed in 0.42s</div>
            <div className="text-on-surface-variant">[INFO] No errors or warnings</div>
          </div>
        )}
        {bottomTab === 'logs' && (
          <div className="p-2 font-mono text-xs text-on-surface-variant space-y-0.5">
            <div className="text-outline">10:42:15 — App initialized</div>
            <div className="text-outline">10:42:16 — Workspace loaded</div>
            <div className="text-outline">10:42:17 — Editor ready</div>
            <div className="text-secondary">10:42:18 — 3D viewport initialized</div>
          </div>
        )}
      </div>
    </div>
  );
}
