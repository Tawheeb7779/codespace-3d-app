import { useEffect, useState } from 'react';
import { Check, GitBranch, Loader2, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Primitives';
import { useGitStore } from '@/stores/gitStore';
import { useFileStore } from '@/stores/fileStore';
import { toast } from '@/stores/toastStore';
import { errorMessage } from '@/lib/utils';
import { cx } from '@/lib/utils';

/**
 * Remote branches, and which one this project tracks.
 *
 * The distinction the UI has to keep straight is that a Forge branch and a
 * GitHub branch are different things: switching what this project tracks does
 * not move any local history, and deleting a branch here deletes it on GitHub
 * and nowhere else. Both are labelled as such, and the default branch is never
 * offered for deletion.
 */
export function RemoteBranchesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const remote = useGitStore((s) => s.remote);
  const branches = useGitStore((s) => s.remoteBranches);
  const refresh = useGitStore((s) => s.refreshRemoteBranches);
  const setRemoteBranch = useGitStore((s) => s.setRemoteBranch);
  const deleteRemoteBranch = useGitStore((s) => s.deleteRemoteBranch);
  const canWrite = useFileStore((s) => s.canWrite());

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    refresh()
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  }, [open, refresh]);

  if (!remote) return null;

  const track = async (branch: string) => {
    setBusy(branch);
    setError(null);
    try {
      await setRemoteBranch(branch);
      toast.success(`Now tracking ${branch}`, 'Fetch to see where it stands.');
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (branch: string) => {
    setBusy(branch);
    setError(null);
    try {
      await deleteRemoteBranch(branch);
      toast.success(`Deleted ${branch} on GitHub`);
      setConfirmDelete(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remote branches"
      description={`Branches on ${remote.owner}/${remote.repo}. Tracking one decides where fetch, pull and push go.`}
      size="md"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-3">
        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="scrollbar-thin max-h-72 overflow-y-auto rounded border border-line">
          {loading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-ink-faint">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Reading branches…
            </p>
          ) : !branches.length ? (
            <EmptyState
              title="No branches yet"
              description={`${remote.owner}/${remote.repo} has no commits. Push to create ${remote.branch}.`}
            />
          ) : (
            <ul role="list">
              {branches.map((branch) => {
                const tracked = branch.name === remote.branch;
                const isDefault = branch.name === remote.defaultBranch;
                return (
                  <li
                    key={branch.name}
                    className={cx(
                      'flex items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-0',
                      tracked && 'bg-accent-soft',
                    )}
                  >
                    <GitBranch aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-base text-ink">
                      {branch.name}
                    </span>
                    {isDefault && <Badge>default</Badge>}
                    {branch.protected && <Badge tone="caution">protected</Badge>}
                    {tracked ? (
                      <span className="flex items-center gap-1 text-sm text-accent">
                        <Check aria-hidden className="h-3 w-3" />
                        tracking
                      </span>
                    ) : (
                      <Button
                        size="xs"
                        disabled={!canWrite || busy !== null}
                        loading={busy === branch.name}
                        onClick={() => void track(branch.name)}
                      >
                        Track
                      </Button>
                    )}
                    <Button
                      size="xs"
                      aria-label={`Delete ${branch.name} on GitHub`}
                      // The default branch is the one thing a mis-click here
                      // could not be undone from Forge, so it is never offered.
                      disabled={!canWrite || isDefault || branch.protected || busy !== null}
                      title={
                        isDefault
                          ? 'The default branch cannot be deleted from Forge'
                          : branch.protected
                            ? 'This branch is protected on GitHub'
                            : `Delete ${branch.name} on GitHub`
                      }
                      onClick={() => setConfirmDelete(branch.name)}
                    >
                      <Trash2 aria-hidden className="h-3 w-3" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-sm text-ink-faint">
          Tracking a different branch does not change your files or local history. Your next fetch
          establishes where that branch stands, and your next push goes there.
        </p>

        {confirmDelete && (
          <div className="rounded border border-danger/40 bg-danger/5 p-2.5">
            <p className="text-sm text-ink">
              Delete <span className="font-mono">{confirmDelete}</span> on GitHub? This removes the
              branch for everyone. Local history is untouched.
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button size="xs" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="danger"
                loading={busy === confirmDelete}
                onClick={() => void remove(confirmDelete)}
              >
                Delete on GitHub
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
