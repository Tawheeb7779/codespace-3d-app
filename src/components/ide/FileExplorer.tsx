import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Download,
  FilePlus2,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { PanelHeader, EmptyState } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { FileIcon, DirIcon } from '@/components/ide/FileIcon';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUIStore } from '@/stores/uiStore';
import { toast } from '@/stores/toastStore';
import { buildTree, flattenTree, basename, dirname, isDescendant, joinPath } from '@/lib/vfs';
import { downloadText } from '@/lib/archive';
import { cx, errorMessage } from '@/lib/utils';

type PendingKind = 'file' | 'folder' | 'rename';

interface Pending {
  kind: PendingKind;
  /** Parent directory for creation, or the full path being renamed. */
  base: string;
  initial: string;
}

const ROW_HEIGHT = 22;
/** Above this many entries the tree windows its rows instead of mounting all. */
const VIRTUALIZE_AFTER = 400;

export function FileExplorer() {
  const files = useFileStore((s) => s.files);
  const dirs = useFileStore((s) => s.dirs);
  const dirty = useFileStore((s) => s.dirty);
  const confirmOnDelete = useSettingsStore((s) => s.workspace.confirmOnDelete);
  const canWrite = useFileStore((s) => s.canWrite());
  const createFile = useFileStore((s) => s.createFile);
  const createDir = useFileStore((s) => s.createDir);
  const renamePath = useFileStore((s) => s.rename);
  const removePath = useFileStore((s) => s.remove);
  const duplicatePath = useFileStore((s) => s.duplicate);
  const movePath = useFileStore((s) => s.move);

  const openTab = useEditorStore((s) => s.openTab);
  const activePath = useEditorStore((s) => s.activePath);
  const editorRename = useEditorStore((s) => s.renamePath);
  const editorRemove = useEditorStore((s) => s.removePath);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src']));
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingValue, setPendingValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [target, setTarget] = useState<{ path: string; type: 'file' | 'dir' } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const pendingCreate = useUIStore((s) => s.pendingCreate);
  const consumeCreate = useUIStore((s) => s.consumeCreate);

  const tree = useMemo(() => buildTree(files, dirs), [files, dirs]);
  // Only paths that still exist: `dirty` also records deletions.
  const dirtyPaths = useMemo(() => [...dirty].filter((path) => path in files), [dirty, files]);
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Reveal the active file by expanding its ancestors.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((current) => {
      const next = new Set(current);
      let dir = dirname(activePath);
      let changed = false;
      while (dir) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
        dir = dirname(dir);
      }
      return changed ? next : current;
    });
  }, [activePath]);

  // A "New file" from the command palette lands here, in the one place that
  // knows how creation works.
  useEffect(() => {
    if (!pendingCreate) return;
    consumeCreate();
    if (!canWrite) {
      toast.error('Read-only project', 'You do not have permission to add files here.');
      return;
    }
    const base = activePath ? dirname(activePath) : '';
    if (base) setExpanded((current) => new Set(current).add(base));
    setPending({ kind: pendingCreate, base, initial: '' });
    setPendingValue('');
  }, [pendingCreate, consumeCreate, canWrite, activePath]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const deletePath = useCallback(
    (path: string) => {
      try {
        removePath(path);
        editorRemove(path);
      } catch (error) {
        toast.error('Could not delete', errorMessage(error));
      }
    },
    [removePath, editorRemove],
  );

  /** Ask first unless the user has turned the confirmation off in settings. */
  const requestDelete = useCallback(
    (path: string) => {
      if (confirmOnDelete) setConfirmDelete(path);
      else deletePath(path);
    },
    [confirmOnDelete, deletePath],
  );

  const startCreate = (kind: 'file' | 'folder', base: string) => {
    if (base) setExpanded((current) => new Set(current).add(base));
    setPending({ kind, base, initial: '' });
    setPendingValue('');
  };

  const commitPending = () => {
    if (!pending) return;
    const value = pendingValue.trim();
    if (!value) {
      setPending(null);
      return;
    }
    try {
      if (pending.kind === 'file') {
        const created = createFile(joinPath(pending.base, value));
        openTab(created);
      } else if (pending.kind === 'folder') {
        createDir(joinPath(pending.base, value));
      } else {
        const next = renamePath(pending.base, value);
        editorRename(pending.base, next);
      }
      setPending(null);
    } catch (error) {
      toast.error('Could not apply that name', errorMessage(error));
    }
  };

  /** Drop handler factory: `destination` is the folder receiving the node. */
  const onDrop = (destination: string) => {
    return (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(null);
      const from = event.dataTransfer.getData('text/forge-path');
      if (!from || from === destination) return;
      if (dirname(from) === destination) return;
      try {
        const next = movePath(from, destination);
        editorRename(from, next);
        toast.success('Moved', `${basename(from)} → ${destination || 'project root'}`);
      } catch (error) {
        toast.error('Could not move file', errorMessage(error));
      }
    };
  };

  const menuItems: MenuItem[] = target
    ? [
        ...(target.type === 'dir'
          ? [
              {
                id: 'new-file',
                label: 'New file',
                icon: <FilePlus2 className="h-3.5 w-3.5" />,
                disabled: !canWrite,
                onSelect: () => startCreate('file', target.path),
              },
              {
                id: 'new-folder',
                label: 'New folder',
                icon: <FolderPlus className="h-3.5 w-3.5" />,
                disabled: !canWrite,
                onSelect: () => startCreate('folder', target.path),
              },
            ]
          : [
              {
                id: 'download',
                label: 'Download file',
                icon: <Download className="h-3.5 w-3.5" />,
                onSelect: () => downloadText(files[target.path] ?? '', basename(target.path)),
              },
              {
                id: 'duplicate',
                label: 'Duplicate',
                icon: <Copy className="h-3.5 w-3.5" />,
                disabled: !canWrite,
                onSelect: () => {
                  try {
                    openTab(duplicatePath(target.path));
                  } catch (error) {
                    toast.error('Could not duplicate', errorMessage(error));
                  }
                },
              },
            ]),
        {
          id: 'rename',
          label: 'Rename',
          icon: <Pencil className="h-3.5 w-3.5" />,
          separatorBefore: true,
          disabled: !canWrite,
          onSelect: () => {
            setPending({ kind: 'rename', base: target.path, initial: basename(target.path) });
            setPendingValue(basename(target.path));
          },
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          disabled: !canWrite,
          onSelect: () => requestDelete(target.path),
        },
      ]
    : [];

  const virtualize = rows.length > VIRTUALIZE_AFTER;
  const overscan = 12;
  const startIndex = virtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan) : 0;
  const endIndex = virtualize
    ? Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan)
    : rows.length;
  const slice = rows.slice(startIndex, endIndex);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Explorer"
        actions={
          <>
            <IconButton
              label="New file"
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              disabled={!canWrite}
              onClick={() => startCreate('file', '')}
            />
            <IconButton
              label="New folder"
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              disabled={!canWrite}
              onClick={() => startCreate('folder', '')}
            />
            <IconButton
              label="Collapse all folders"
              icon={<ChevronsDownUp className="h-3.5 w-3.5" />}
              onClick={() => setExpanded(new Set())}
            />
          </>
        }
      />

      <div
        ref={listRef}
        role="tree"
        aria-label="Project files"
        className="scrollbar-thin relative flex-1 overflow-y-auto py-1"
        onScroll={(event) => virtualize && setScrollTop(event.currentTarget.scrollTop)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver('');
        }}
        onDrop={onDrop('')}
      >
        {rows.length === 0 && !pending ? (
          <EmptyState
            title="No files yet"
            description="Create your first file to get started."
            action={
              canWrite && (
                <Button size="xs" onClick={() => startCreate('file', '')}>
                  New file
                </Button>
              )
            }
          />
        ) : (
          <div style={virtualize ? { height: rows.length * ROW_HEIGHT, position: 'relative' } : undefined}>
            <div
              style={
                virtualize
                  ? { position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }
                  : undefined
              }
            >
              {slice.map((node) => {
                const isActive = node.type === 'file' && node.path === activePath;
                const isOpen = expanded.has(node.path);
                // A collapsed folder still says that something inside it is
                // unsaved, so nothing is hidden by being folded away.
                const isDirty =
                  node.type === 'file'
                    ? dirty.has(node.path)
                    : !isOpen && dirtyPaths.some((path) => isDescendant(path, node.path));
                return (
                  <div
                    key={node.path}
                    role="treeitem"
                    aria-selected={isActive}
                    aria-expanded={node.type === 'dir' ? isOpen : undefined}
                    tabIndex={0}
                    draggable={canWrite}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/forge-path', node.path);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={
                      node.type === 'dir'
                        ? (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setDragOver(node.path);
                          }
                        : undefined
                    }
                    onDrop={node.type === 'dir' ? (event) => {
                      event.stopPropagation();
                      onDrop(node.path)(event);
                    } : undefined}
                    onClick={() => (node.type === 'dir' ? toggle(node.path) : openTab(node.path))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (node.type === 'dir') toggle(node.path);
                        else openTab(node.path);
                      } else if (event.key === 'ArrowRight' && node.type === 'dir' && !isOpen) {
                        toggle(node.path);
                      } else if (event.key === 'ArrowLeft' && node.type === 'dir' && isOpen) {
                        toggle(node.path);
                      } else if (event.key === 'F2' && canWrite) {
                        event.preventDefault();
                        setPending({ kind: 'rename', base: node.path, initial: basename(node.path) });
                        setPendingValue(basename(node.path));
                      } else if (event.key === 'Delete' && canWrite) {
                        requestDelete(node.path);
                      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        // Move focus between rows, so the tree is navigable
                        // without reaching for the mouse.
                        event.preventDefault();
                        const row = event.currentTarget;
                        const sibling =
                          event.key === 'ArrowDown'
                            ? row.nextElementSibling
                            : row.previousElementSibling;
                        (sibling as HTMLElement | null)?.focus();
                      }
                    }}
                    onContextMenu={(event) => {
                      setTarget({ path: node.path, type: node.type });
                      menu.open(event);
                    }}
                    style={{ paddingLeft: node.depth * 12 + 8, height: ROW_HEIGHT }}
                    className={cx(
                      'flex cursor-pointer select-none items-center gap-1.5 pr-2 text-base outline-none',
                      'transition-colors',
                      isActive
                        ? 'bg-accent-soft text-ink'
                        : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
                      dragOver === node.path && node.type === 'dir' && 'bg-accent/20',
                    )}
                  >
                    {node.type === 'dir' ? (
                      <>
                        <ChevronRight
                          aria-hidden
                          className={cx(
                            'h-3 w-3 shrink-0 text-ink-faint transition-transform',
                            isOpen && 'rotate-90',
                          )}
                        />
                        <DirIcon open={isOpen} />
                      </>
                    ) : (
                      <>
                        <span className="w-3 shrink-0" />
                        <FileIcon path={node.path} />
                      </>
                    )}
                    <span className={cx('truncate', isDirty && 'text-ink')}>{node.name}</span>
                    {isDirty && (
                      <span
                        aria-label="Unsaved changes"
                        title="Unsaved changes"
                        className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {pending && pending.kind !== 'rename' && (
          <div
            className="flex items-center gap-1.5 px-2 py-0.5"
            style={{ paddingLeft: (pending.base.split('/').filter(Boolean).length || 0) * 12 + 20 }}
          >
            <input
              autoFocus
              aria-label={pending.kind === 'file' ? 'New file name' : 'New folder name'}
              value={pendingValue}
              onChange={(event) => setPendingValue(event.target.value)}
              onBlur={commitPending}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPending();
                if (event.key === 'Escape') setPending(null);
              }}
              placeholder={pending.kind === 'file' ? 'name.ts' : 'folder'}
              className="h-5 w-full rounded-sm border border-accent bg-surface-sunken px-1 text-base text-ink outline-none"
            />
          </div>
        )}
      </div>

      <Menu items={menuItems} anchor={menu.anchor} onClose={menu.close} label="File actions" />

      <Modal
        open={Boolean(pending && pending.kind === 'rename')}
        onClose={() => setPending(null)}
        title="Rename"
        size="sm"
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="primary" onClick={commitPending}>
              Rename
            </Button>
          </>
        }
      >
        <Input
          label="New name"
          autoFocus
          value={pendingValue}
          onChange={(event) => setPendingValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && commitPending()}
          hint="Use a path to move the file, for example src/lib/name.ts"
        />
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) deletePath(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          Delete <span className="font-mono">{confirmDelete}</span> and everything inside it? Commit
          first if you want to be able to restore it.
        </p>
      </Modal>
    </div>
  );
}
