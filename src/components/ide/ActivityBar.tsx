import {
  Activity,
  Bot,
  Files,
  GitBranch,
  LayoutList,
  ListChecks,
  Package,
  Search,
  Users,
} from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useUIStore, type SidebarPanel } from '@/stores/uiStore';
import { useGitStore } from '@/stores/gitStore';
import { cx } from '@/lib/utils';

const PANELS: Array<{ id: SidebarPanel; label: string; icon: typeof Files }> = [
  { id: 'project', label: 'Project', icon: LayoutList },
  { id: 'explorer', label: 'Explorer', icon: Files },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'git', label: 'Source control', icon: GitBranch },
  { id: 'packages', label: 'Packages', icon: Package },
  { id: 'assistant', label: 'Assistant', icon: Bot },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'activity', label: 'Activity', icon: Activity },
];

export function ActivityBar() {
  const { sidebarPanel, sidebarOpen, setSidebarPanel } = useUIStore();
  const changes = useGitStore((s) => s.status.staged.length + s.status.unstaged.length);

  return (
    <nav
      aria-label="Workspace panels"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2"
    >
      {PANELS.map((panel) => {
        const active = sidebarOpen && sidebarPanel === panel.id;
        return (
          <Tooltip key={panel.id} content={panel.label} side="right">
            <button
              type="button"
              aria-label={panel.label}
              aria-pressed={active}
              onClick={() => setSidebarPanel(panel.id)}
              className={cx(
                'relative flex h-8 w-8 items-center justify-center rounded transition-colors',
                active ? 'text-ink' : 'text-ink-faint hover:text-ink',
              )}
            >
              {active && (
                <span aria-hidden className="absolute -left-2 h-5 w-0.5 rounded-full bg-accent" />
              )}
              <panel.icon className="h-4 w-4" />
              {panel.id === 'git' && changes > 0 && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-ink"
                >
                  {changes > 99 ? '99' : changes}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
