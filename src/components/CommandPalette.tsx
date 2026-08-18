import { useState, useEffect, useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useProjectStore } from '@/stores/projectStore';
import { Modal } from '@/components/ui/Modal';
import {
  Search,
  FolderGit2,
  LayoutDashboard,
  Boxes,
  Package,
  HardDrive,
  Users,
  MessageSquare,
  Bell,
  Settings,
  FileCode,
  Command,
  Plus,
} from 'lucide-react';
import type { ViewMode } from '@/types';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: typeof Search;
  action: () => void;
  category: string;
}

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, setView } = useUIStore();
  const { projects, setActiveProject } = useProjectStore();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCommandPaletteOpen]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [commandPaletteOpen]);

  const commands: CommandItem[] = useMemo(() => {
    const navCommands: CommandItem[] = [
      { id: 'nav-dashboard', label: 'Dashboard', icon: LayoutDashboard, category: 'Navigation', action: () => setView('dashboard') },
      { id: 'nav-workspace', label: 'Open Workspace', icon: Boxes, category: 'Navigation', action: () => setView('workspace') },
      { id: 'nav-projects', label: 'Projects', icon: FolderGit2, category: 'Navigation', action: () => setView('projects') },
      { id: 'nav-assets', label: 'Asset Manager', icon: Package, category: 'Navigation', action: () => setView('assets') },
      { id: 'nav-storage', label: 'Storage Manager', icon: HardDrive, category: 'Navigation', action: () => setView('storage') },
      { id: 'nav-team', label: 'Team Management', icon: Users, category: 'Navigation', action: () => setView('team') },
      { id: 'nav-chat', label: 'Team Chat', icon: MessageSquare, category: 'Navigation', action: () => setView('chat') },
      { id: 'nav-notifications', label: 'Notifications', icon: Bell, category: 'Navigation', action: () => setView('notifications') },
      { id: 'nav-settings', label: 'Settings', icon: Settings, category: 'Navigation', action: () => setView('settings') },
      { id: 'nav-search', label: 'Global Search', icon: Search, category: 'Navigation', action: () => setView('search') },
      { id: 'nav-new-project', label: 'New Project', icon: Plus, category: 'Actions', action: () => setView('projects') },
    ];

    const projectCommands: CommandItem[] = projects.map((p) => ({
      id: `proj-${p.id}`,
      label: p.name,
      description: p.description,
      icon: FileCode,
      category: 'Projects',
      action: () => {
        setActiveProject(p.id);
        setView('workspace');
      },
    }));

    return [...navCommands, ...projectCommands];
  }, [projects, setActiveProject, setView]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[selectedIndex];
      if (item) {
        item.action();
        setCommandPaletteOpen(false);
      }
    }
  };

  const categories = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    filtered.forEach((c) => {
      if (!map.has(c.category)) map.set(c.category, []);
      map.get(c.category)!.push(c);
    });
    return Array.from(map.entries());
  }, [filtered]);

  let flatIndex = -1;

  return (
    <Modal open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} className="max-w-xl">
      <div className="-m-5">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/10">
          <Command size={16} className="text-outline" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-outline focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 rounded bg-surface-high text-[10px] font-mono text-outline border border-outline-variant/20">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-outline">No results found</div>
          )}
          {categories.map(([category, items]) => (
            <div key={category}>
              <div className="px-3 py-1 text-[10px] font-label-caps text-outline uppercase tracking-wider">
                {category}
              </div>
              {items.map((item) => {
                flatIndex++;
                const idx = flatIndex;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => {
                      item.action();
                      setCommandPaletteOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                      idx === selectedIndex ? 'bg-primary/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <Icon size={16} className={idx === selectedIndex ? 'text-primary' : 'text-outline'} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm ${idx === selectedIndex ? 'text-primary' : 'text-on-surface'}`}>
                        {item.label}
                      </div>
                      {item.description && (
                        <div className="text-xs text-outline truncate">{item.description}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
