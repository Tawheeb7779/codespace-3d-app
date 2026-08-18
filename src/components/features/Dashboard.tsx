import { useProjectStore } from '@/stores/projectStore';
import { useUIStore } from '@/stores/uiStore';
import { useTeamStore } from '@/stores/teamStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Toast';
import { formatTimeAgo, formatBytes } from '@/lib/utils';
import { Plus, FolderGit2, Activity, Users, Bell, TrendingUp, Clock, FileCode, Box, Zap } from 'lucide-react';

export function Dashboard() {
  const { projects, setActiveProject } = useProjectStore();
  const setView = useUIStore((s) => s.setView);
  const members = useTeamStore((s) => s.members);
  const notifications = useNotificationStore((s) => s.notifications);

  const onlineMembers = members.filter((m) => m.online).length;
  const totalFiles = projects.reduce((sum, p) => sum + p.files.length, 0);
  const totalSize = projects.reduce((sum, p) => sum + p.files.reduce((s, f) => s + (f.content?.length ?? 0), 0), 0);

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[1400px] mx-auto space-y-4">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
              <TrendingUp className="text-primary" size={28} />
              Dashboard
            </h1>
            <p className="text-on-surface-variant text-sm mt-1">Welcome back to CodeSpace 3D</p>
          </div>
          <Button variant="primary" onClick={() => setView('projects')}>
            <Plus size={16} /> New Project
          </Button>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <FolderGit2 size={16} className="text-primary" />
              <span className="font-label-caps text-label-caps text-on-surface-variant">Projects</span>
            </div>
            <div className="text-2xl font-bold text-on-surface">{projects.length}</div>
            <div className="text-xs text-outline mt-1">{projects.length === 0 ? 'Create one to start' : 'Active workspace'}</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileCode size={16} className="text-secondary" />
              <span className="font-label-caps text-label-caps text-on-surface-variant">Files</span>
            </div>
            <div className="text-2xl font-bold text-on-surface">{totalFiles}</div>
            <div className="text-xs text-outline mt-1">{formatBytes(totalSize)} total</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-tertiary" />
              <span className="font-label-caps text-label-caps text-on-surface-variant">Team</span>
            </div>
            <div className="text-2xl font-bold text-on-surface">{onlineMembers}/{members.length}</div>
            <div className="text-xs text-outline mt-1">Online now</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Bell size={16} className="text-error" />
              <span className="font-label-caps text-label-caps text-on-surface-variant">Alerts</span>
            </div>
            <div className="text-2xl font-bold text-on-surface">{notifications.filter((n) => !n.read).length}</div>
            <div className="text-xs text-outline mt-1">Unread</div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Recent Projects */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-headline-md text-lg text-on-surface flex items-center gap-2">
                <Clock size={18} className="text-outline" /> Recent Projects
              </h2>
              <button onClick={() => setView('projects')} className="text-xs text-primary hover:underline">View all</button>
            </div>
            {projects.length === 0 ? (
              <Card className="p-8 text-center">
                <Box size={40} className="mx-auto text-outline mb-3" />
                <p className="text-sm text-on-surface-variant mb-4">No projects yet. Create one to get started.</p>
                <Button variant="primary" onClick={() => setView('projects')}>
                  <Plus size={16} /> Create Project
                </Button>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {projects.slice(0, 4).map((project) => (
                  <Card key={project.id} hover className="p-4" onClick={() => { setActiveProject(project.id); setView('workspace'); }}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Box size={18} className="text-primary" />
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-on-surface">{project.name}</div>
                          <div className="text-xs text-outline">{project.template}</div>
                        </div>
                      </div>
                      <Badge color="primary">{project.files.length} files</Badge>
                    </div>
                    <p className="text-xs text-on-surface-variant line-clamp-2 mb-3">{project.description || 'No description'}</p>
                    <div className="flex items-center justify-between text-[10px] text-outline font-mono">
                      <span>{formatTimeAgo(project.updatedAt)}</span>
                      <span>{project.sceneObjects?.length ?? 0} objects</span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Activity Feed */}
          <div>
            <h2 className="font-headline-md text-lg text-on-surface flex items-center gap-2 mb-3">
              <Activity size={18} className="text-outline" /> Recent Activity
            </h2>
            <Card className="p-3">
              <div className="space-y-3">
                {notifications.slice(0, 5).map((n) => (
                  <div key={n.id} className="flex items-start gap-2">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.read ? 'bg-outline' : 'bg-primary animate-pulse'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-on-surface">{n.title}</div>
                      <div className="text-xs text-outline truncate">{n.message}</div>
                      <div className="text-[10px] text-outline mt-0.5">{formatTimeAgo(n.timestamp)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="font-headline-md text-lg text-on-surface flex items-center gap-2 mb-3">
            <Zap size={18} className="text-tertiary" /> Quick Actions
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'New Project', icon: Plus, view: 'projects' as const, color: 'text-primary' },
              { label: 'Workspace', icon: Box, view: 'workspace' as const, color: 'text-secondary' },
              { label: 'Team Chat', icon: Users, view: 'chat' as const, color: 'text-tertiary' },
              { label: 'Assets', icon: FileCode, view: 'assets' as const, color: 'text-success' },
            ].map((action) => {
              const Icon = action.icon;
              return (
                <Card key={action.label} hover className="p-4 flex flex-col items-center gap-2" onClick={() => setView(action.view)}>
                  <Icon size={24} className={action.color} />
                  <span className="text-xs text-on-surface-variant">{action.label}</span>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
