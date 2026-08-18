import { useUIStore } from '@/stores/uiStore';
import { useProjectStore } from '@/stores/projectStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Toast';
import {
  PanelLeft,
  PanelRight,
  PanelBottom,
  Search,
  Bell,
  Menu,
  Cloud,
  Plus,
} from 'lucide-react';

export function TopBar() {
  const {
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    setCommandPaletteOpen,
    setView,
    setMobileNavOpen,
    currentView,
  } = useUIStore();
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const unreadCount = useNotificationStore((s) => s.unreadCount());

  const viewTitles: Record<string, string> = {
    dashboard: 'Dashboard',
    workspace: 'Workspace',
    projects: 'Projects',
    assets: 'Asset Manager',
    storage: 'Storage Manager',
    search: 'Global Search',
    team: 'Team Management',
    chat: 'Team Chat',
    notifications: 'Notifications',
    settings: 'Settings',
  };

  return (
    <header className="h-12 bg-surface/80 backdrop-blur-xl border-b border-outline-variant/10 flex items-center justify-between px-3 z-50 shrink-0">
      <div className="flex items-center gap-2">
        <IconButton onClick={setMobileNavOpen.bind(null, true)} className="md:hidden">
          <Menu size={18} />
        </IconButton>
        <IconButton onClick={toggleLeftSidebar} className="hidden md:flex">
          <PanelLeft size={18} />
        </IconButton>
        <div className="flex items-center gap-2 ml-1">
          <span className="font-headline-md text-base font-bold tracking-tight text-gradient">
            CodeSpace 3D
          </span>
          <Badge color="primary">v1.0</Badge>
        </div>
        <div className="hidden lg:flex items-center gap-2 ml-4 text-on-surface-variant text-sm">
          <span className="text-outline">/</span>
          <span>{viewTitles[currentView] ?? 'View'}</span>
          {activeProject && (
            <>
              <span className="text-outline">/</span>
              <span className="text-secondary">{activeProject.name}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg glass-elevated text-xs text-on-surface-variant hover:text-on-surface transition-all glow-active"
        >
          <Search size={14} />
          <span>Search...</span>
          <kbd className="px-1.5 py-0.5 rounded bg-surface-high text-[10px] font-mono text-outline border border-outline-variant/20">
            ⌘K
          </kbd>
        </button>

        <IconButton onClick={() => setView('workspace')} className="hidden sm:flex">
          <Plus size={18} />
        </IconButton>

        <IconButton className="hidden sm:flex">
          <Cloud size={18} />
        </IconButton>

        <IconButton onClick={() => setView('notifications')} active={unreadCount > 0}>
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-error text-[8px] flex items-center justify-center text-on-error font-bold">
              {unreadCount}
            </span>
          )}
        </IconButton>

        <IconButton onClick={toggleBottomPanel} className="hidden md:flex">
          <PanelBottom size={18} />
        </IconButton>
        <IconButton onClick={toggleRightSidebar} className="hidden md:flex">
          <PanelRight size={18} />
        </IconButton>

        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-on-primary text-xs font-bold ml-1">
          AC
        </div>
      </div>
    </header>
  );
}
