import { useEffect, useMemo, useState } from 'react';
import { Layers, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { toast } from '@/stores/toastStore';
import { MAX_RECENT_WORKSPACES, useWorkspaceStore } from '@/stores/workspaceStore';
import { cx, errorMessage } from '@/lib/utils';

/**
 * Workspaces: named groupings of projects.
 *
 * A workspace narrows what the dashboard shows; it grants nothing. Every
 * project listed inside one is still subject to its own membership, so this
 * bar is a filter, not an access-control surface — which is why it can be
 * purely local state on top of the project list the user could already see.
 */
export function WorkspaceBar({
  onSelect,
  activeId,
}: {
  onSelect: (id: string | null) => void;
  activeId: string | null;
}) {
  const load = useWorkspaceStore((s) => s.load);
  // Subscribe to the raw list and derive here. A selector that calls
  // `recent()` returns a fresh array every render, which zustand reads as a
  // change — that is an infinite update loop, not a re-render optimisation.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const recent = useMemo(
    () =>
      [...workspaces]
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.openedAt - a.openedAt;
        })
        .slice(0, MAX_RECENT_WORKSPACES),
    [workspaces],
  );
  const create = useWorkspaceStore((s) => s.create);
  const open = useWorkspaceStore((s) => s.open);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const remove = useWorkspaceStore((s) => s.remove);
  const error = useWorkspaceStore((s) => s.error);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const guard = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast.error(label, errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1.5 text-sm text-ink-faint">
        <Layers aria-hidden className="h-3.5 w-3.5" />
        Workspace
      </span>

      <button
        type="button"
        aria-pressed={activeId === null}
        onClick={() => onSelect(null)}
        className={cx(
          'rounded border px-2 py-0.5 text-sm transition-colors',
          activeId === null
            ? 'border-accent bg-accent-soft text-ink'
            : 'border-line text-ink-muted hover:text-ink',
        )}
      >
        All projects
      </button>

      {recent.map((workspace) => (
        <span key={workspace.id} className="flex items-center">
          <button
            type="button"
            aria-pressed={activeId === workspace.id}
            onClick={() => {
              onSelect(workspace.id);
              void open(workspace.id);
            }}
            className={cx(
              'flex items-center gap-1 rounded-l border border-r-0 px-2 py-0.5 text-sm transition-colors',
              activeId === workspace.id
                ? 'border-accent bg-accent-soft text-ink'
                : 'border-line text-ink-muted hover:text-ink',
            )}
          >
            {workspace.pinned && <Pin aria-hidden className="h-2.5 w-2.5 text-accent" />}
            {workspace.name}
            <span className="text-ink-faint">{workspace.projectIds.length}</span>
          </button>
          <IconButton
            size="xs"
            label={workspace.pinned ? `Unpin ${workspace.name}` : `Pin ${workspace.name}`}
            icon={
              workspace.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />
            }
            disabled={busy}
            onClick={() => void guard('Could not update workspace', () => togglePin(workspace.id))}
          />
          <IconButton
            size="xs"
            label={`Delete ${workspace.name}`}
            icon={<Trash2 className="h-3 w-3" />}
            disabled={busy}
            onClick={() => setConfirmDelete({ id: workspace.id, name: workspace.name })}
          />
        </span>
      ))}

      <IconButton
        size="xs"
        label="New workspace"
        icon={<Plus className="h-3 w-3" />}
        onClick={() => setCreateOpen(true)}
      />

      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New workspace"
        description="A named grouping of projects. It changes what you see, not who can see it."
        size="sm"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void guard('Could not create workspace', async () => {
                  const workspace = await create({ name, description });
                  toast.success('Workspace created', workspace.name);
                  setName('');
                  setDescription('');
                  setCreateOpen(false);
                  onSelect(workspace.id);
                })
              }
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Client work"
          />
          <Input
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional"
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete workspace"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (!target) return;
                void guard('Could not delete workspace', async () => {
                  await remove(target.id);
                  if (activeId === target.id) onSelect(null);
                  toast.success('Workspace deleted', target.name);
                });
              }}
            >
              Delete workspace
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          Delete <span className="font-medium">{confirmDelete?.name}</span>? The projects inside it
          are not deleted — only the grouping.
        </p>
      </Modal>
    </div>
  );
}
