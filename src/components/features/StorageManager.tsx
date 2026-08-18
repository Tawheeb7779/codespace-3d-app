import { useProjectStore } from '@/stores/projectStore';
import { useEditorStore } from '@/stores/editorStore';
import { useTeamStore } from '@/stores/teamStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { formatBytes } from '@/lib/utils';
import { HardDrive, Database, Cloud, AlertTriangle, Download, RefreshCw, Trash2, Table } from 'lucide-react';

export function StorageManager() {
  const projects = useProjectStore((s) => s.projects);
  const fileContents = useEditorStore((s) => s.fileContents);
  const messages = useTeamStore((s) => s.messages);
  const notifications = useNotificationStore((s) => s.notifications);

  const projectsSize = projects.reduce((sum, p) => sum + p.files.reduce((s, f) => s + (fileContents[f.id]?.length ?? f.content?.length ?? 0), 0), 0);
  const sceneSize = projects.reduce((sum, p) => sum + (p.sceneObjects?.length ?? 0) * 1024, 0);
  const editorStateSize = Object.values(fileContents).reduce((s, c) => s + c.length, 0);
  const chatSize = messages.reduce((s, m) => s + m.content.length, 0);
  const notifSize = notifications.reduce((s, n) => s + (n.title.length + n.message.length), 0);

  const totalUsed = projectsSize + sceneSize + editorStateSize + chatSize + notifSize;
  const quota = 2 * 1024 * 1024 * 1024;
  const usedPct = Math.min(100, (totalUsed / quota) * 100);
  const circumference = 2 * Math.PI * 54;
  const dashOffset = circumference - (usedPct / 100) * circumference;

  const stores = [
    { name: 'Projects', icon: Table, size: projectsSize, records: projects.length, access: 'Read/Write' },
    { name: 'Assets', icon: Database, size: 0, records: 0, access: 'Read/Write' },
    { name: 'EditorState', icon: HardDrive, size: editorStateSize, records: Object.keys(fileContents).length, access: 'Volatile' },
    { name: 'ChatMessages', icon: Table, size: chatSize, records: messages.length, access: 'Read/Write' },
    { name: 'Notifications', icon: Table, size: notifSize, records: notifications.length, access: 'Read-Only' },
  ];

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[1200px] mx-auto space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
              <HardDrive className="text-primary" size={28} /> Storage Manager
            </h1>
            <p className="text-on-surface-variant text-sm mt-1">Manage local storage and persistence</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary"><RefreshCw size={14} /> Force Sync</Button>
            <Button variant="primary"><Download size={14} /> Export JSON</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Storage gauge */}
          <Card className="lg:col-span-4 p-5 flex flex-col items-center">
            <div className="w-full flex items-center justify-between mb-4 pb-2 border-b border-outline-variant/10">
              <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
                <Database size={16} className="text-outline" /> Local Storage
              </h2>
              <Badge color="primary">IDB_MAIN</Badge>
            </div>
            <div className="relative w-48 h-48 my-4">
              <svg className="w-48 h-48" viewBox="0 0 120 120">
                <circle cx="60" cy="60" fill="none" r="54" stroke="#171c26" strokeWidth="8" />
                <circle
                  cx="60" cy="60" fill="none" r="54" stroke="#adc6ff" strokeWidth="8"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%', transition: 'stroke-dashoffset 0.35s' }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold text-on-surface">{formatBytes(totalUsed)}</span>
                <span className="text-xs text-outline mt-1">of {formatBytes(quota)} quota</span>
              </div>
            </div>
            <div className="flex justify-between w-full text-xs pt-3 border-t border-outline-variant/10">
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-3 h-3 rounded-full bg-primary" /> Used
              </div>
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-3 h-3 rounded-full bg-surface-high border border-outline-variant/30" /> Available
              </div>
            </div>
          </Card>

          {/* Store cards */}
          <div className="lg:col-span-8">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-outline-variant/10">
              <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
                <Table size={16} className="text-outline" /> Active Stores
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {stores.map((store) => {
                const Icon = store.icon;
                return (
                  <Card key={store.name} hover className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <Icon size={16} className="text-primary" />
                        <span className="text-sm font-semibold text-on-surface">{store.name}</span>
                      </div>
                      <Badge>{store.access}</Badge>
                    </div>
                    <div className="flex justify-between items-end mt-3">
                      <div>
                        <div className="text-xl font-bold text-on-surface">{store.records}</div>
                        <div className="text-xs text-outline">Records</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-mono text-secondary">{formatBytes(store.size)}</div>
                        <div className="text-[10px] text-outline">Live data</div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Sync & Danger */}
          <Card className="lg:col-span-4 p-5">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-outline-variant/10">
              <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
                <Cloud size={16} className="text-outline" /> Sync Status
              </h2>
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            </div>
            <div className="space-y-3 text-xs">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Provider</span>
                <span className="font-mono text-on-surface">Local (IndexedDB)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Last Sync</span>
                <span className="font-mono text-secondary">{new Date().toLocaleTimeString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Pending</span>
                <span className="font-mono text-tertiary">{projects.length} projects</span>
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-4 p-5 border-error/20">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-outline-variant/10">
              <h2 className="text-sm font-semibold text-error flex items-center gap-2">
                <AlertTriangle size={16} /> Danger Zone
              </h2>
            </div>
            <div className="space-y-2">
              <Button variant="danger" className="w-full justify-between">
                <span>Clear Cache</span>
                <Trash2 size={14} />
              </Button>
              <Button variant="danger" className="w-full justify-between">
                <span>Reset Local Storage</span>
                <Trash2 size={14} />
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
