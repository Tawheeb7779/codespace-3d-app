import { useState, useMemo, useEffect, useRef } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useUIStore } from '@/stores/uiStore';
import { useTeamStore } from '@/stores/teamStore';
import { defaultAssets } from '@/lib/defaultAssets';
import { Card } from '@/components/ui/Card';
import { Search, FileCode, Box, Package, Users, Command, FolderGit2 } from 'lucide-react';

export function GlobalSearch() {
  const { projects, setActiveProject } = useProjectStore();
  const setView = useUIStore((s) => s.setView);
  const members = useTeamStore((s) => s.members);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return { files: [], projects: [], assets: [], members: [] };
    const q = query.toLowerCase();
    return {
      files: projects.flatMap((p) =>
        p.files
          .filter((f) => f.name.toLowerCase().includes(q) || (f.content?.toLowerCase().includes(q) ?? false))
          .map((f) => ({ project: p, file: f }))
      ),
      projects: projects.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)),
      assets: defaultAssets.filter((a) => a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q)),
      members: members.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)),
    };
  }, [query, projects, members]);

  const totalResults = results.files.length + results.projects.length + results.assets.length + results.members.length;

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[800px] mx-auto space-y-4">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
            <Search className="text-primary" size={28} /> Global Search
          </h1>
          <p className="text-on-surface-variant text-sm mt-1">Search across files, projects, assets, and team</p>
        </div>

        <div className="relative">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything..."
            className="w-full bg-surface-low border border-outline-variant/20 rounded-lg pl-10 pr-4 py-3 text-sm text-on-surface placeholder:text-outline focus:border-primary/50 focus:outline-none"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded bg-surface-high text-[10px] font-mono text-outline border border-outline-variant/20">
            ⌘K
          </kbd>
        </div>

        {query.trim() && (
          <p className="text-xs text-outline">{totalResults} result(s) for "{query}"</p>
        )}

        {totalResults === 0 && query.trim() && (
          <Card className="p-8 text-center">
            <Search size={32} className="mx-auto text-outline mb-2" />
            <p className="text-sm text-on-surface-variant">No results found</p>
          </Card>
        )}

        {results.projects.length > 0 && (
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2 flex items-center gap-1.5">
              <FolderGit2 size={14} /> Projects ({results.projects.length})
            </h3>
            <div className="space-y-1">
              {results.projects.map((p) => (
                <Card key={p.id} hover className="p-3 flex items-center gap-3" onClick={() => { setActiveProject(p.id); setView('workspace'); }}>
                  <Box size={16} className="text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface">{p.name}</div>
                    <div className="text-xs text-outline truncate">{p.description}</div>
                  </div>
                  <span className="text-[10px] text-outline font-mono">{p.template}</span>
                </Card>
              ))}
            </div>
          </div>
        )}

        {results.files.length > 0 && (
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2 flex items-center gap-1.5">
              <FileCode size={14} /> Files ({results.files.length})
            </h3>
            <div className="space-y-1">
              {results.files.slice(0, 10).map(({ project, file }) => (
                <Card key={file.id} hover className="p-3 flex items-center gap-3" onClick={() => { setActiveProject(project.id); setView('workspace'); }}>
                  <FileCode size={16} className="text-secondary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface">{file.name}</div>
                    <div className="text-xs text-outline">{project.name}</div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {results.assets.length > 0 && (
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2 flex items-center gap-1.5">
              <Package size={14} /> Assets ({results.assets.length})
            </h3>
            <div className="space-y-1">
              {results.assets.map((a) => (
                <Card key={a.id} hover className="p-3 flex items-center gap-3" onClick={() => setView('assets')}>
                  <Package size={16} className="text-tertiary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface">{a.name}</div>
                    <div className="text-xs text-outline">{a.type} · {a.location}</div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {results.members.length > 0 && (
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2 flex items-center gap-1.5">
              <Users size={14} /> Team ({results.members.length})
            </h3>
            <div className="space-y-1">
              {results.members.map((m) => (
                <Card key={m.id} hover className="p-3 flex items-center gap-3" onClick={() => setView('team')}>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-on-primary text-xs font-bold shrink-0">
                    {m.avatar}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface">{m.name}</div>
                    <div className="text-xs text-outline">{m.email}</div>
                  </div>
                  <span className="text-[10px] text-outline font-mono">{m.role}</span>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
