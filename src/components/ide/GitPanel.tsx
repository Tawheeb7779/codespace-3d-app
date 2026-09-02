import { useEffect, useState } from 'react';
import {
  Check,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { FileIcon } from '@/components/ide/FileIcon';
import { DiffViewer } from '@/components/ide/DiffViewer';
import { useGitStore } from '@/stores/gitStore';
import { useFileStore } from '@/stores/fileStore';
import { toast } from '@/stores/toastStore';
import * as vcs from '@/lib/vcs';
import type { FileChange } from '@/lib/vcs';
import { basename } from '@/lib/vfs';
import { cx, errorMessage, formatTimeAgo } from '@/lib/utils';

const STATUS_MARK: Record<FileChange['status'], { label: string; tone: string }> = {
  added: { label: 'A', tone: 'text-positive' },
  modified: { label: 'M', tone: 'text-caution' },
  deleted: { label: 'D', tone: 'text-danger' },
  renamed: { label: 'R', tone: 'text-accent' },
};

function ChangeRow({
  change,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  selected,
  staged,
  canWrite,
}: {
  change: FileChange;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  selected: boolean;
  staged: boolean;
  canWrite: boolean;
}) {
  const mark = STATUS_MARK[change.status];
  return (
    <div
      className={cx(
        'group flex items-center gap-1.5 px-2.5 py-0.5 text-base',
        selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-raised',
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <FileIcon path={change.path} />
        <span className="truncate">{basename(change.path)}</span>
        <span className="truncate text-sm text-ink-faint">{change.path}</span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {!staged && onDiscard && (
          <IconButton
            label={`Discard changes to ${change.path}`}
            size="xs"
            disabled={!canWrite}
            icon={<RotateCcw className="h-3 w-3" />}
            onClick={onDiscard}
          />
        )}
        {staged ? (
          <IconButton
            label={`Unstage ${change.path}`}
            size="xs"
            icon={<Minus className="h-3 w-3" />}
            onClick={onUnstage}
          />
        ) : (
          <IconButton
            label={`Stage ${change.path}`}
            size="xs"
            icon={<Plus className="h-3 w-3" />}
            onClick={onStage}
          />
        )}
      </div>
      <span className={cx('w-3 shrink-0 text-center font-mono text-sm', mark.tone)}>{mark.label}</span>
    </div>
  );
}

export function GitPanel() {
  const {
    repo,
    status,
    history,
    selectedPath,
    init,
    refresh,
    stage,
    unstage,
    discard,
    commit,
    createBranch,
    checkout,
    merge,
    select,
  } = useGitStore();
  const files = useFileStore((s) => s.files);
  const canWrite = useFileStore((s) => s.canWrite());

  const [message, setMessage] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');

  useEffect(() => {
    refresh();
  }, [files, refresh]);

  const guard = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(label, errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!repo.initialized) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Source control" />
        <EmptyState
          icon={<GitBranch className="h-4 w-4" />}
          title="No repository yet"
          description="Forge VCS keeps commits, branches and diffs with this project, entirely in your browser."
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={!canWrite}
              onClick={() => void guard('Could not initialize', init)}
            >
              Initialize repository
            </Button>
          }
        />
      </div>
    );
  }

  const selectedBefore = selectedPath ? vcs.headContent(repo, selectedPath) : '';
  const selectedAfter = selectedPath ? (files[selectedPath] ?? '') : '';

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Source control"
        actions={
          <>
            <IconButton
              label="New branch"
              icon={<GitBranch className="h-3.5 w-3.5" />}
              disabled={!canWrite}
              onClick={() => setBranchOpen(true)}
            />
            <IconButton
              label="Merge a branch"
              icon={<GitMerge className="h-3.5 w-3.5" />}
              disabled={!canWrite || Object.keys(repo.branches).length < 2}
              onClick={() => setMergeOpen(true)}
            />
            <IconButton
              label="Refresh status"
              icon={<History className="h-3.5 w-3.5" />}
              onClick={refresh}
            />
          </>
        }
      />

      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <GitBranch className="h-3 w-3 text-ink-faint" />
        <select
          aria-label="Current branch"
          value={repo.head}
          disabled={!canWrite}
          onChange={(event) =>
            void guard('Could not switch branch', () => checkout(event.target.value))
          }
          className="min-w-0 flex-1 truncate bg-transparent text-base text-ink outline-none"
        >
          {Object.keys(repo.branches)
            .sort()
            .map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
        </select>
        <Badge>{status.clean ? 'clean' : `${status.staged.length + status.unstaged.length}`}</Badge>
      </div>

      <div role="tablist" aria-label="Source control view" className="flex border-b border-line">
        {(
          [
            ['changes', 'Changes'],
            ['history', 'History'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cx(
              'px-3 py-1.5 text-sm transition-colors',
              tab === value
                ? 'border-b-2 border-accent text-ink'
                : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'changes' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-line p-2.5">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Commit message"
              rows={2}
              disabled={!canWrite}
              className="w-full resize-none rounded border border-line bg-surface-sunken px-2 py-1.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="primary"
                className="flex-1"
                loading={busy}
                disabled={!canWrite || !message.trim() || !status.staged.length}
                leading={<Check className="h-3.5 w-3.5" />}
                onClick={() =>
                  void guard('Commit failed', async () => {
                    const created = await commit(message);
                    setMessage('');
                    toast.success('Committed', `${created.id.slice(0, 7)} ${created.message}`);
                  })
                }
              >
                Commit
              </Button>
              <Button
                size="sm"
                disabled={!canWrite || status.clean}
                onClick={() => void guard('Could not stage', () => stage())}
              >
                Stage all
              </Button>
            </div>
            {!status.staged.length && !status.clean && (
              <p className="mt-1.5 text-sm text-ink-faint">Stage a file to enable committing.</p>
            )}
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-1">
            {status.clean ? (
              <EmptyState title="Working tree clean" description="No changes since the last commit." />
            ) : (
              <>
                {status.staged.length > 0 && (
                  <>
                    <p className="panel-label px-2.5 py-1">Staged</p>
                    {status.staged.map((change) => (
                      <ChangeRow
                        key={`s-${change.path}`}
                        change={change}
                        staged
                        canWrite={canWrite}
                        selected={selectedPath === change.path}
                        onSelect={() => select(change.path)}
                        onUnstage={() =>
                          void guard('Could not unstage', () => unstage([change.path]))
                        }
                      />
                    ))}
                  </>
                )}
                {status.unstaged.length > 0 && (
                  <>
                    <p className="panel-label px-2.5 py-1">Changes</p>
                    {status.unstaged.map((change) => (
                      <ChangeRow
                        key={`u-${change.path}`}
                        change={change}
                        staged={false}
                        canWrite={canWrite}
                        selected={selectedPath === change.path}
                        onSelect={() => select(change.path)}
                        onStage={() => void guard('Could not stage', () => stage([change.path]))}
                        onDiscard={() =>
                          void guard('Could not discard', () => discard([change.path]))
                        }
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {selectedPath && (
            <div className="flex h-56 shrink-0 flex-col border-t border-line">
              <div className="flex items-center gap-2 border-b border-line px-2.5 py-1">
                <FileIcon path={selectedPath} />
                <span className="truncate text-sm text-ink">{selectedPath}</span>
                <button
                  type="button"
                  onClick={() => select(null)}
                  className="ml-auto text-sm text-ink-faint hover:text-ink"
                >
                  Close
                </button>
              </div>
              <DiffViewer
                before={selectedBefore}
                after={selectedAfter}
                emptyLabel="This file matches HEAD."
              />
            </div>
          )}
        </div>
      ) : (
        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {!history.length ? (
            <EmptyState title="No commits yet" description="Stage some files and make your first commit." />
          ) : (
            history.map((entry) => (
              <div key={entry.id} className="border-b border-line px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <p className="min-w-0 flex-1 truncate text-base text-ink">{entry.message}</p>
                  <span className="shrink-0 font-mono text-sm text-ink-faint">
                    {entry.id.slice(0, 7)}
                  </span>
                </div>
                <p className="mt-0.5 pl-5 text-sm text-ink-faint">
                  {entry.author} · {formatTimeAgo(entry.timestamp)} ·{' '}
                  {Object.keys(entry.tree).length} files
                </p>
              </div>
            ))
          )}
        </div>
      )}

      <p className="border-t border-line px-2.5 py-1.5 text-sm text-ink-faint">
        Local version control. Push, pull and clone against a git remote are not available — use
        Export ZIP to move work out.
      </p>

      <Modal
        open={branchOpen}
        onClose={() => setBranchOpen(false)}
        title="New branch"
        size="sm"
        footer={
          <>
            <Button onClick={() => setBranchOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void guard('Could not create branch', async () => {
                  await createBranch(branchName, true);
                  toast.success('Branch created', branchName);
                  setBranchName('');
                  setBranchOpen(false);
                })
              }
            >
              Create and switch
            </Button>
          </>
        }
      >
        <Input
          label="Branch name"
          autoFocus
          value={branchName}
          onChange={(event) => setBranchName(event.target.value)}
          placeholder="feature/preview-toolbar"
          hint={`Branches from ${repo.head}.`}
        />
      </Modal>

      <Modal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title={`Merge into ${repo.head}`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!mergeFrom}
              onClick={() =>
                void guard('Merge failed', async () => {
                  const result = await merge(mergeFrom);
                  setMergeOpen(false);
                  if (result.upToDate) toast.info('Already up to date');
                  else if (result.conflicts.length) {
                    toast.warning(
                      `${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'}`,
                      'Conflict markers were written into the affected files.',
                    );
                  } else toast.success('Merged', mergeFrom);
                })
              }
            >
              Merge
            </Button>
          </>
        }
      >
        <label className="block text-sm font-medium text-ink-muted" htmlFor="merge-source">
          Source branch
        </label>
        <select
          id="merge-source"
          value={mergeFrom}
          onChange={(event) => setMergeFrom(event.target.value)}
          className="mt-1.5 h-8 w-full rounded border border-line bg-surface-sunken px-2 text-base text-ink focus:border-accent focus:outline-none"
        >
          <option value="">Select a branch…</option>
          {Object.keys(repo.branches)
            .filter((branch) => branch !== repo.head)
            .sort()
            .map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
        </select>
        <p className="mt-2 text-sm text-ink-faint">
          Files that both branches changed are merged line by line. Overlapping edits are written
          with conflict markers for you to resolve.
        </p>
      </Modal>
    </div>
  );
}
