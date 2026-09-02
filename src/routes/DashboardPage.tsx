import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Hammer,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SquarePen,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Field';
import { Badge, EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Primitives';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Modal } from '@/components/ui/Modal';
import { CreateProjectDialog } from '@/components/dashboard/CreateProjectDialog';
import { ImportDialog } from '@/components/dashboard/ImportDialog';
import { useProjectStore } from '@/stores/projectStore';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import type { ProjectMeta } from '@/types';
import { cx, errorMessage, formatTimeAgo } from '@/lib/utils';
import { isSupabaseConfigured } from '@/lib/supabase';

type Filter = 'all' | 'starred' | 'archived';

function ProjectCard({
  project,
  onMenu,
  onToggleStar,
}: {
  project: ProjectMeta;
  onMenu: (event: React.MouseEvent, project: ProjectMeta) => void;
  onToggleStar: (project: ProjectMeta) => void;
}) {
  return (
    <article
      className={cx(
        'group relative flex flex-col rounded-lg border border-line bg-surface p-4 transition-colors',
        'hover:border-line-strong focus-within:border-accent',
      )}
      onContextMenu={(event) => onMenu(event, project)}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/project/${project.id}`}
          className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:content-['']"
        >
          <h3 className="truncate text-md font-medium text-ink">{project.name}</h3>
          <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-ink-muted">
            {project.description || 'No description'}
          </p>
        </Link>
        <div className="relative z-10 flex shrink-0 items-center gap-0.5">
          <IconButton
            label={project.starred ? 'Remove star' : 'Star project'}
            icon={
              <Star
                className={cx('h-3.5 w-3.5', project.starred && 'fill-caution text-caution')}
              />
            }
            onClick={() => onToggleStar(project)}
          />
          <IconButton
            label={`Actions for ${project.name}`}
            icon={<MoreHorizontal className="h-3.5 w-3.5" />}
            onClick={(event) => onMenu(event, project)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-ink-faint">
        <Badge>{project.language}</Badge>
        {project.status === 'archived' && <Badge tone="caution">Archived</Badge>}
        <span className="ml-auto">{formatTimeAgo(project.updatedAt)}</span>
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { projects, loading, error, load, rename, remove, duplicate, toggleStar, setStatus } =
    useProjectStore();
  const { user, signOut, localMode } = useAuthStore();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [renaming, setRenaming] = useState<ProjectMeta | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null);
  const [target, setTarget] = useState<ProjectMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menu = useContextMenu();

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects
      .filter((project) => {
        if (filter === 'starred' && !project.starred) return false;
        if (filter === 'archived') return project.status === 'archived';
        if (project.status === 'archived') return false;
        if (!needle) return true;
        return (
          project.name.toLowerCase().includes(needle) ||
          project.description.toLowerCase().includes(needle) ||
          project.language.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects, query, filter]);

  const openMenu = useCallback(
    (event: React.MouseEvent, project: ProjectMeta) => {
      setTarget(project);
      menu.open(event);
    },
    [menu],
  );

  const menuItems: MenuItem[] = target
    ? [
        {
          id: 'open',
          label: 'Open project',
          icon: <SquarePen className="h-3.5 w-3.5" />,
          onSelect: () => navigate(`/project/${target.id}`),
        },
        {
          id: 'rename',
          label: 'Rename',
          icon: <SquarePen className="h-3.5 w-3.5" />,
          onSelect: () => {
            setRenameValue(target.name);
            setRenaming(target);
          },
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => {
            void duplicate(target.id)
              .then((project) => toast.success('Project duplicated', project.name))
              .catch((caught) => toast.error('Could not duplicate', errorMessage(caught)));
          },
        },
        {
          id: 'archive',
          label: target.status === 'archived' ? 'Restore' : 'Archive',
          icon:
            target.status === 'archived' ? (
              <ArchiveRestore className="h-3.5 w-3.5" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            ),
          separatorBefore: true,
          onSelect: () => {
            void setStatus(target.id, target.status === 'archived' ? 'active' : 'archived').catch(
              (caught) => toast.error('Could not update project', errorMessage(caught)),
            );
          },
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          onSelect: () => setDeleting(target),
        },
      ]
    : [];

  const confirmRename = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await rename(renaming.id, renameValue);
      setRenaming(null);
    } catch (caught) {
      toast.error('Could not rename', errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await remove(deleting.id);
      toast.success('Project deleted', deleting.name);
      setDeleting(null);
    } catch (caught) {
      toast.error('Could not delete', errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
        <Link to="/" className="flex items-center gap-2 text-ink">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-accent-ink">
            <Hammer className="h-3 w-3" />
          </span>
          <span className="text-base font-semibold">Forge</span>
        </Link>

        {localMode && <Badge tone="caution">Local Mode</Badge>}
        {isSupabaseConfigured && !localMode && <Badge tone="positive">Cloud</Badge>}

        <div className="ml-auto flex items-center gap-2">
          <Link to="/settings">
            <IconButton label="Settings" icon={<Settings className="h-3.5 w-3.5" />} />
          </Link>
          <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
              {user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}
            </span>
            <span className="max-w-[140px] truncate text-sm text-ink-muted">
              {user?.displayName}
            </span>
          </div>
          <IconButton
            label="Sign out"
            icon={<LogOut className="h-3.5 w-3.5" />}
            onClick={() => {
              void signOut()
                .then(() => navigate('/'))
                .catch((caught) => toast.error('Sign out failed', errorMessage(caught)));
            }}
          />
        </div>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-ink">Projects</h1>
              <p className="mt-1 text-base text-ink-muted">
                {projects.length} project{projects.length === 1 ? '' : 's'} in your workspace
              </p>
            </div>
            <div className="flex gap-2">
              <Button leading={<Upload className="h-3.5 w-3.5" />} onClick={() => setImportOpen(true)}>
                Import
              </Button>
              <Button
                variant="primary"
                leading={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setCreateOpen(true)}
              >
                New project
              </Button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="min-w-[220px] flex-1">
              <Input
                ref={searchRef}
                aria-label="Search projects"
                placeholder="Search projects…  (Ctrl K)"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                leading={<Search className="h-3.5 w-3.5" />}
              />
            </div>
            <div role="tablist" aria-label="Project filter" className="flex gap-1 rounded border border-line p-0.5">
              {(
                [
                  ['all', 'All'],
                  ['starred', 'Starred'],
                  ['archived', 'Archived'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  type="button"
                  aria-selected={filter === value}
                  onClick={() => setFilter(value)}
                  className={cx(
                    'rounded-sm px-2.5 py-1 text-sm transition-colors',
                    filter === value
                      ? 'bg-surface-raised text-ink'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            {error ? (
              <ErrorState title="Could not load projects" detail={error} onRetry={() => void load()} />
            ) : loading && !projects.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="rounded-lg border border-line bg-surface">
                    <SkeletonRows rows={3} />
                  </div>
                ))}
              </div>
            ) : visible.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onMenu={openMenu}
                    onToggleStar={(item) =>
                      void toggleStar(item.id).catch((caught) =>
                        toast.error('Could not update star', errorMessage(caught)),
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Hammer className="h-4 w-4" />}
                title={query ? 'No projects match that search' : 'No projects yet'}
                description={
                  query
                    ? 'Try a different name, language or description.'
                    : 'Create one from a template, or import a ZIP or public GitHub repository.'
                }
                action={
                  !query && (
                    <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                      New project
                    </Button>
                  )
                }
                className="rounded-lg border border-dashed border-line"
              />
            )}
          </div>
        </div>
      </div>

      <Menu items={menuItems} anchor={menu.anchor} onClose={menu.close} label="Project actions" />
      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename project"
        size="sm"
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void confirmRename()}>
              Rename
            </Button>
          </>
        }
      >
        <Input
          label="Project name"
          autoFocus
          value={renameValue}
          maxLength={60}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void confirmRename()}
        />
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete project"
        size="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={() => void confirmDelete()}>
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          <span className="font-medium">{deleting?.name}</span> and all of its files and version
          history will be removed. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
