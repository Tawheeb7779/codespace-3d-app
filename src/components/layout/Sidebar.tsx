import { useUIStore } from '@/stores/uiStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  LayoutDashboard,
  FolderGit2,
  Files,
  Package,
  HardDrive,
  Search,
  Users,
  MessageSquare,
  Bell,
  Settings,
  Boxes,
} from 'lucide-react';
import type { ViewMode } from '@/types';

const navItems: { view: ViewMode; icon: typeof LayoutDashboard; label: string }[] = [
  { view: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'projects', icon: FolderGit2, label: 'Projects' },
  { view: 'workspace', icon: Boxes, label: 'Workspace' },
  { view: 'assets', icon: Package, label: 'Assets' },
  { view: 'storage', icon: HardDrive, label: 'Storage' },
  { view: 'search', icon: Search, label: 'Search' },
  { view: 'team', icon: Users, label: 'Team' },
  { view: 'chat', icon: MessageSquare, label: 'Chat' },
  { view: 'notifications', icon: Bell, label: 'Notifications' },
  { view: 'settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const { currentView, setView, setMobileNavOpen } = useUIStore();
  const unreadCount = useNotificationStore((s) => s.unreadCount());
  const activeProject = useProjectStore((s) => s.getActiveProject());

  const handleNav = (view: ViewMode) => {
    setView(view);
    setMobileNavOpen(false);
  };

  return (
    <nav className="flex flex-col gap-1 px-2 py-3">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = currentView === item.view;
        const showBadge = item.view === 'notifications' && unreadCount > 0;

        return (
          <button
            key={item.view}
            onClick={() => handleNav(item.view)}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all group ${
              isActive
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5 border border-transparent'
            }`}
          >
            <Icon size={18} className="shrink-0" />
            <span className="flex-1 text-left font-medium">{item.label}</span>
            {showBadge && (
              <span className="px-1.5 py-0.5 rounded-full bg-error/20 text-error text-[10px] font-mono">
                {unreadCount}
              </span>
            )}
            {isActive && !showBadge && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}

      {activeProject && (
        <div className="mt-auto pt-3 border-t border-outline-variant/10">
          <div className="px-3 py-2 rounded-lg bg-surface-low/50">
            <div className="text-[10px] font-label-caps text-outline mb-1">Active Project</div>
            <div className="text-sm text-on-surface truncate">{activeProject.name}</div>
            <div className="text-[10px] font-mono text-outline mt-0.5">
              {activeProject.template} · {activeProject.files.length} files
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
