import { useEffect, useState } from 'react';
import { Github, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch } from '@/components/ui/Field';
import { GithubConnection } from '@/components/github/GithubConnection';
import { RepoBrowser } from '@/components/github/RepoBrowser';
import { useGithubStore } from '@/stores/githubStore';
import { useGitStore } from '@/stores/gitStore';
import { toast } from '@/stores/toastStore';
import type { GithubBranch, GithubRepo } from '@/lib/github/types';
import { errorMessage } from '@/lib/utils';

/**
 * Point this project at a GitHub repository.
 *
 * Connecting only records where the project should sync to; it moves no code
 * on its own. The first fetch or push is a separate, explicit action, which
 * keeps a mis-click from overwriting either side.
 */
export function ConnectRepoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useGithubStore((s) => s.status);
  const listBranches = useGithubStore((s) => s.listBranches);
  const createRepo = useGithubStore((s) => s.createRepo);
  const searchRepos = useGithubStore((s) => s.searchRepos);
  const connectRemote = useGitStore((s) => s.connectRemote);

  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [branches, setBranches] = useState<GithubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [autoInit, setAutoInit] = useState(false);

  useEffect(() => {
    if (!open) {
      setRepo(null);
      setBranches([]);
      setBranch('');
      setError(null);
      setTab('existing');
    }
  }, [open]);

  useEffect(() => {
    if (!repo) return;
    setBranch(repo.defaultBranch);
    setBranches([]);
    let cancelled = false;
    listBranches(repo)
      .then((items) => !cancelled && setBranches(items))
      // An empty repository has no branches; that is not an error.
      .catch(() => !cancelled && setBranches([]));
    return () => {
      cancelled = true;
    };
  }, [repo, listBranches]);

  const connect = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await connectRemote(repo, branch || repo.defaultBranch);
      toast.success('Repository connected', `${repo.fullName} · ${branch || repo.defaultBranch}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createRepo({ name, description, private: isPrivate, autoInit });
      await connectRemote(created, created.defaultBranch);
      toast.success('Repository created', `${created.fullName} is now connected`);
      void searchRepos('', 1);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const connected = status === 'connected';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a GitHub repository"
      description="Forge will fetch from and push to the branch you pick. Nothing moves until you ask."
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {connected && tab === 'existing' ? (
            <Button variant="primary" disabled={!repo || busy} loading={busy} onClick={() => void connect()}>
              Connect repository
            </Button>
          ) : connected ? (
            <Button
              variant="primary"
              disabled={!name.trim() || busy}
              loading={busy}
              onClick={() => void create()}
            >
              Create and connect
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {!connected ? (
          <GithubConnection compact />
        ) : (
          <>
            <div role="tablist" aria-label="Repository source" className="flex gap-1 rounded border border-line p-1">
              {(
                [
                  ['existing', 'Existing repository', Github],
                  ['new', 'Create a repository', Plus],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  role="tab"
                  type="button"
                  aria-selected={tab === value}
                  onClick={() => {
                    setTab(value);
                    setError(null);
                  }}
                  className={
                    tab === value
                      ? 'flex flex-1 items-center justify-center gap-2 rounded-sm bg-surface-raised px-3 py-1.5 text-base text-ink'
                      : 'flex flex-1 items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-base text-ink-muted hover:text-ink'
                  }
                >
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {tab === 'existing' ? (
              <>
                <RepoBrowser onSelect={setRepo} selected={repo} requireWrite />
                {repo && (
                  <Select
                    label="Branch to track"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    options={
                      branches.length
                        ? branches.map((item) => ({
                            value: item.name,
                            label: item.protected ? `${item.name} (protected)` : item.name,
                          }))
                        : [{ value: repo.defaultBranch, label: `${repo.defaultBranch} (new)` }]
                    }
                    hint={
                      branches.length
                        ? 'Fetch and push act on this branch.'
                        : 'This repository has no commits yet — your first push will create the branch.'
                    }
                  />
                )}
              </>
            ) : (
              <div className="space-y-3">
                <Input
                  label="Repository name"
                  value={name}
                  maxLength={100}
                  placeholder="my-project"
                  onChange={(event) => setName(event.target.value)}
                  hint="Letters, numbers, and . _ - only."
                />
                <Input
                  label="Description"
                  value={description}
                  maxLength={350}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <Switch
                  label="Private repository"
                  checked={isPrivate}
                  onChange={setPrivate}
                  description="Private is the safer default for work in progress."
                />
                <Switch
                  label="Add a README"
                  checked={autoInit}
                  onChange={setAutoInit}
                  description="Creates a first commit. Leave it off to make your project the first commit."
                />
                <p className="text-sm text-ink-faint">
                  This creates a real repository on the connected GitHub account.
                </p>
              </div>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
