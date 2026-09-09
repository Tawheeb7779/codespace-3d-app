import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Check,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Badge, EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { FileIcon } from '@/components/ide/FileIcon';
import {
  subscribeWorkspace,
  workspaceConnected,
  workspaceContainerId,
} from '@/lib/ai/workspaceBridge';
import { useWorkspaceGitStore, type WorkspaceGitFile } from '@/stores/workspaceGitStore';
import { toast } from '@/stores/toastStore';
import { useIsTouch } from '@/hooks/useMediaQuery';
import { basename } from '@/lib/vfs';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * Real git, in the project's container.
 *
 * Everything on this screen was read from `git` a moment ago. Nothing is
 * inferred: the branch is what `rev-parse` said, the file list is porcelain v2,
 * the diff is `git diff`. When the container is not attached the panel says so
 * and offers nothing, rather than showing the in-browser repository's state
 * under a heading that claims to be the container's — which would be the same
 * dishonesty as an agent reporting tests it never ran.
 *
 * **Destructive actions go through the gateway's refusal.** Discarding,
 * switching branches and deleting a branch are sent without confirmation first;
 * the gateway answers `needsConfirmation` with the paths that would be lost, and
 * only then is a person asked. The list they are shown is therefore git's own
 * account of what is at risk rather than this component's guess at it.
 */

/** Whether a project container is attached, as a subscription rather than a poll. */
function useWorkspace(): { connected: boolean; containerId: string | null } {
  const connected = useSyncExternalStore(subscribeWorkspace, workspaceConnected, () => false);
  const containerId = useSyncExternalStore(
    subscribeWorkspace,
    workspaceContainerId,
    () => null,
  );
  return { connected, containerId };
}

/**
 * The porcelain code, as a letter a person reads.
 *
 * Git's two-letter code is index-then-worktree; the panel already separates
 * staged from unstaged into two lists, so what is shown here is whichever half
 * belongs to the list the row is in.
 */
function mark(file: WorkspaceGitFile, staged: boolean): { label: string; tone: string } {
  if (file.untracked) return { label: 'U', tone: 'text-positive' };
  const letter = (staged ? file.code[0] : file.code[1]) ?? '?';
  switch (letter) {
    case 'A':
      return { label: 'A', tone: 'text-positive' };
    case 'D':
      return { label: 'D', tone: 'text-danger' };
    case 'R':
      return { label: 'R', tone: 'text-accent' };
    case 'M':
      return { label: 'M', tone: 'text-caution' };
    default:
      return { label: letter.trim() || 'M', tone: 'text-caution' };
  }
}

/** A unified diff, coloured by line kind. Git's output, not a reconstruction of it. */
function PatchView({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n').slice(0, 4000), [patch]);
  if (!patch.trim()) {
    return (
      <p className="p-3 text-sm text-ink-faint">
        <span>Git reports no textual change for this file.</span>
      </p>
    );
  }
  return (
    <pre className="scrollbar-thin h-full overflow-auto bg-surface-sunken p-2 font-mono text-sm leading-5">
      {lines.map((line, index) => {
        const tone = line.startsWith('+++') || line.startsWith('---')
          ? 'text-ink-faint'
          : line.startsWith('@@')
            ? 'text-accent'
            : line.startsWith('+')
              ? 'text-positive'
              : line.startsWith('-')
                ? 'text-danger'
                : 'text-ink-muted';
        return (
          <div key={index} className={cx('whitespace-pre', tone)}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function ChangeRow({
  file,
  staged,
  selected,
  busy,
  touch,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: WorkspaceGitFile;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  /**
   * Whether the pointer is a finger.
   *
   * Hover-revealed actions are the standard IDE idiom and are the right one for
   * a cursor, but there is no hover on a touch screen: a row whose stage and
   * discard buttons appear on `:hover` has no stage and discard buttons at all
   * on a phone. They stay visible instead.
   */
  touch: boolean;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const badge = mark(file, staged);
  return (
    <div
      className={cx(
        'group flex items-center gap-1.5 px-2.5 py-0.5 text-base',
        selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-raised',
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <FileIcon path={file.path} />
        <span className="truncate">{basename(file.path)}</span>
        <span className="truncate text-sm text-ink-faint">{file.path}</span>
      </button>
      <div
        className={cx(
          'flex shrink-0 items-center gap-0.5 transition-opacity',
          touch ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        {onDiscard && (
          <IconButton
            label={`Discard changes to ${file.path}`}
            size="xs"
            disabled={busy}
            icon={<RotateCcw className="h-3 w-3" />}
            onClick={onDiscard}
          />
        )}
        {staged ? (
          <IconButton
            label={`Unstage ${file.path}`}
            size="xs"
            disabled={busy}
            icon={<Minus className="h-3 w-3" />}
            onClick={onUnstage}
          />
        ) : (
          <IconButton
            label={`Stage ${file.path}`}
            size="xs"
            disabled={busy}
            icon={<Plus className="h-3 w-3" />}
            onClick={onStage}
          />
        )}
      </div>
      <span className={cx('w-3 shrink-0 text-center font-mono text-sm', badge.tone)}>
        {badge.label}
      </span>
    </div>
  );
}

export function WorkspaceGitPanel() {
  const { connected, containerId } = useWorkspace();
  const touch = useIsTouch();
  const {
    busy,
    loading,
    error,
    status,
    log,
    branches,
    selectedPath,
    diff,
    diffLoading,
    confirming,
    refresh,
    clear,
    select,
    run,
    confirm,
    cancelConfirmation,
  } = useWorkspaceGitStore();

  const [message, setMessage] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [tab, setTab] = useState<'changes' | 'history'>('changes');

  /**
   * Read once per container, and clear when there is none.
   *
   * Keyed by container id rather than by `connected`, so reconnecting to a
   * rebuilt container re-reads rather than trusting what the last one said.
   */
  useEffect(() => {
    if (!connected) {
      clear();
      return;
    }
    void refresh();
  }, [connected, containerId, refresh, clear]);

  if (!connected) {
    return (
      <EmptyState
        icon={<GitBranch className="h-4 w-4" />}
        title="No container workspace attached"
        description="Open the project terminal to attach this project's container. Real git runs there — this panel reads it and does not simulate it."
      />
    );
  }

  if (loading && !status) return <SkeletonRows rows={6} />;

  if (error && !status) {
    return (
      <ErrorState title="Could not read the repository" detail={error} onRetry={() => void refresh()} />
    );
  }

  if (status && !status.repository) {
    return (
      <EmptyState
        icon={<GitBranch className="h-4 w-4" />}
        title="No git repository in this workspace"
        description="The container has this project's files but no repository yet."
        action={
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() =>
              void run({ op: 'init' }, 'Initialising the repository').then((outcome) => {
                if (outcome.applied) toast.success('Repository initialised');
                else if (outcome.message) toast.error('Initialising the repository', outcome.message);
              })
            }
          >
            Run git init
          </Button>
        }
      />
    );
  }

  const files = status?.files ?? [];
  const staged = files.filter((file) => file.staged);
  const unstaged = files.filter((file) => file.unstaged || file.untracked);
  const selected = selectedPath ? files.find((file) => file.path === selectedPath) : undefined;

  const act: (
    operation: Parameters<typeof run>[0],
    what: string,
    onDone?: (data: unknown) => void,
  ) => void = (operation, what, onDone) =>
    void run(operation, what).then((outcome) => {
      if (outcome.applied) onDone?.(outcome.data);
      else if (!outcome.awaitingConfirmation && outcome.message) toast.error(what, outcome.message);
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <GitBranch aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
        <select
          aria-label="Workspace branch"
          value={branches.current ?? ''}
          disabled={busy || !branches.all.length}
          onChange={(event) =>
            act({ op: 'checkout', ref: event.target.value }, 'Switching branch', () =>
              toast.success('Switched branch', event.target.value),
            )
          }
          className="min-w-0 flex-1 truncate bg-transparent text-base text-ink outline-none"
        >
          {!branches.current && <option value="">{status?.unborn ? 'no commits yet' : 'detached HEAD'}</option>}
          {branches.all.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <Badge tone={status?.dirty ? 'caution' : 'positive'}>
          {status?.dirty ? String(files.length) : 'clean'}
        </Badge>
        <IconButton
          label="New branch"
          size="xs"
          disabled={busy}
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setBranchOpen(true)}
        />
        <IconButton
          label={`Delete the ${branches.current ?? 'current'} branch`}
          size="xs"
          disabled={busy || branches.all.length < 2 || !branches.current}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() =>
            branches.current &&
            act({ op: 'delete-branch', name: branches.current }, 'Deleting the branch', () =>
              toast.success('Branch deleted', branches.current ?? ''),
            )
          }
        />
        <IconButton
          label="Re-read the repository"
          size="xs"
          disabled={busy || loading}
          icon={<RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />}
          onClick={() => void refresh()}
        />
      </div>

      <div role="tablist" aria-label="Workspace git view" className="flex border-b border-line">
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
              'tap-target px-3 py-1.5 text-sm transition-colors',
              tab === value
                ? 'border-b-2 border-accent text-ink'
                : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error && status && (
        <p role="alert" className="border-b border-danger/40 bg-danger/5 px-2.5 py-1 text-sm text-danger">
          <span>{error}</span>
        </p>
      )}

      {tab === 'changes' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-line p-2.5">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Commit message"
              rows={2}
              disabled={busy}
              className="w-full resize-none rounded border border-line bg-surface-sunken px-2 py-1.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="primary"
                className="flex-1"
                loading={busy}
                disabled={busy || !message.trim() || !staged.length}
                leading={<Check className="h-3.5 w-3.5" />}
                onClick={() =>
                  act({ op: 'commit', message }, 'Commit', (data) => {
                    const created = data as { hash?: string; subject?: string } | undefined;
                    setMessage('');
                    toast.success('Committed', `${created?.hash?.slice(0, 7) ?? ''} ${created?.subject ?? ''}`.trim());
                  })
                }
              >
                Commit
              </Button>
              <Button
                size="sm"
                disabled={busy || !unstaged.length}
                onClick={() =>
                  act(
                    { op: 'add', paths: unstaged.map((file) => file.path) },
                    'Staging every change',
                  )
                }
              >
                Stage all
              </Button>
            </div>
            {!staged.length && (
              <p className="mt-1.5 text-sm text-ink-faint">
                <span>Git commits what is staged. Stage a file to enable committing.</span>
              </p>
            )}
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-1">
            {!files.length ? (
              <EmptyState title="Working tree clean" description="Git reports no changes in the container." />
            ) : (
              <>
                {staged.length > 0 && (
                  <>
                    <p className="panel-label px-2.5 py-1">
                      <span>Staged</span>
                    </p>
                    {staged.map((file) => (
                      <ChangeRow
                        key={`s-${file.path}`}
                        file={file}
                        staged
                        busy={busy}
                        touch={touch}
                        selected={selectedPath === file.path}
                        onSelect={() => void select(file.path, true)}
                        onUnstage={() => act({ op: 'unstage', paths: [file.path] }, 'Unstaging')}
                      />
                    ))}
                  </>
                )}
                {unstaged.length > 0 && (
                  <>
                    <p className="panel-label px-2.5 py-1">
                      <span>Changes</span>
                    </p>
                    {unstaged.map((file) => (
                      <ChangeRow
                        key={`u-${file.path}`}
                        file={file}
                        staged={false}
                        busy={busy}
                        touch={touch}
                        selected={selectedPath === file.path}
                        onSelect={() => void select(file.path, false)}
                        onStage={() => act({ op: 'add', paths: [file.path] }, 'Staging')}
                        onDiscard={() => act({ op: 'discard', paths: [file.path] }, 'Discarding changes')}
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
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{selectedPath}</span>
                <button
                  type="button"
                  onClick={() => void select(null)}
                  className="tap-target text-sm text-ink-faint hover:text-ink"
                >
                  <span>Close</span>
                </button>
              </div>
              {diffLoading ? (
                <SkeletonRows rows={4} />
              ) : selected?.untracked ? (
                <p className="p-3 text-sm text-ink-faint">
                  <span>This file is untracked, so git has nothing to diff it against yet.</span>
                </p>
              ) : diff === null ? (
                <p className="p-3 text-sm text-ink-faint">
                  <span>The diff could not be read.</span>
                </p>
              ) : (
                <PatchView patch={diff} />
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {!log.length ? (
            <EmptyState
              title="No commits yet"
              description={
                status?.unborn
                  ? 'This branch has no commits. Stage some files and commit.'
                  : 'Git reported no history for this branch.'
              }
            />
          ) : (
            log.map((entry) => (
              <div key={entry.hash} className="border-b border-line px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <GitCommitHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <p className="min-w-0 flex-1 truncate text-base text-ink">{entry.subject}</p>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-ink-faint">
                    {entry.shortHash}
                  </span>
                </div>
                <p className="mt-0.5 pl-5 text-sm text-ink-faint">
                  {entry.author} · {formatTimeAgo(entry.at)}
                </p>
              </div>
            ))
          )}
        </div>
      )}

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
              disabled={!branchName.trim()}
              onClick={() =>
                act({ op: 'create-branch', name: branchName.trim() }, 'Creating the branch', () => {
                  toast.success('Branch created', branchName.trim());
                  setBranchName('');
                  setBranchOpen(false);
                })
              }
            >
              Create
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
          hint={`Created from ${branches.current ?? 'the current commit'}. Switch to it from the branch menu.`}
        />
      </Modal>

      {/*
        The gateway refused this operation because it would lose work, and said
        which files. What is listed is git's answer, so the question a person is
        asked is a true one.
      */}
      <Modal
        open={Boolean(confirming)}
        onClose={cancelConfirmation}
        title={confirming ? `${confirming.what}?` : ''}
        size="sm"
        footer={
          <>
            <Button onClick={cancelConfirmation}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void confirm().then((outcome) => {
                  if (!outcome.applied && outcome.message) {
                    toast.error(confirming?.what ?? 'Operation failed', outcome.message);
                  }
                })
              }
            >
              Discard and continue
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">{confirming?.message}</p>
        {confirming && confirming.atRisk.length > 0 && (
          <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-line bg-surface-sunken p-2">
            {confirming.atRisk.map((path) => (
              <li key={path} className="truncate font-mono text-sm text-ink-muted">
                {path}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
