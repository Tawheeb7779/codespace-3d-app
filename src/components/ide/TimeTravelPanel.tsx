import { useMemo, useState } from 'react';
import { Bookmark, History, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { PanelHeader, EmptyState } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { FileIcon } from '@/components/ide/FileIcon';
import { DiffViewer } from '@/components/ide/DiffViewer';
import { useTimeTravelStore } from '@/stores/timeTravelStore';
import { useFileStore } from '@/stores/fileStore';
import { useConsoleStore } from '@/stores/consoleStore';
import { useAiStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';
import { toast } from '@/stores/toastStore';
import {
  MAX_SNAPSHOTS,
  REASON_LABEL,
  diffAgainst,
  divergencePrompt,
  planRestore,
  type Snapshot,
} from '@/lib/timetravel/history';
import { basename } from '@/lib/vfs';
import { cx, errorMessage, formatTimeAgo } from '@/lib/utils';

/**
 * Going back to how the project was.
 *
 * The panel says what this is in as many words, because the phrase "time travel
 * debugging" promises something else: replaying an application's execution
 * backwards, which needs a runtime that records and re-drives it. The preview
 * here is an ordinary sandboxed browser frame, and nothing in this architecture
 * can do that.
 *
 * What it does instead is real. The project's files are recorded at moments
 * that matter — before the assistant changes anything, on a commit, when
 * somebody marks a point — and any of those can be diffed against the project
 * as it is, asked about, or restored. That answers "what did I break, and
 * when", which is usually the actual question.
 *
 * A restore overwrites work, so what it would do is computed and shown first,
 * including which files cannot be restored because they were too large to
 * record.
 */

export function TimeTravelPanel() {
  const { snapshots, restoring, capture, remove, clear, setRestoring } = useTimeTravelStore();
  const files = useFileStore((s) => s.files);
  const writeFile = useFileStore((s) => s.writeFile);
  const removePath = useFileStore((s) => s.remove);
  const canWrite = useFileStore((s) => s.canWrite());
  const entries = useConsoleStore((s) => s.entries);
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectPath, setInspectPath] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Snapshot | null>(null);

  const selected = snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;

  const comparison = useMemo(
    () => (selected ? diffAgainst(selected, files) : null),
    [selected, files],
  );

  const plan = useMemo(
    () => (confirming ? planRestore(confirming, files) : null),
    [confirming, files],
  );

  /** Console entries since the selected point, which is what was observed. */
  const eventsSince = useMemo(() => {
    if (!selected) return [];
    return entries
      .filter((entry) => entry.timestamp >= selected.at)
      .slice(-30)
      .reverse()
      .map((entry) => ({ source: entry.channel, title: entry.message.split('\n')[0] }));
  }, [selected, entries]);

  const applyRestore = async (snapshot: Snapshot) => {
    setRestoring(true);
    try {
      /*
       * Record where we are before overwriting it.
       *
       * The dialog promises the restore can be undone, and this is what makes
       * that true. Taken first, so a failure part-way through still leaves a
       * point to come back to.
       */
      capture(useFileStore.getState().files, 'manual', `Before restoring "${snapshot.label}"`);
      const restorePlan = planRestore(snapshot, useFileStore.getState().files);
      for (const path of restorePlan.willWrite) writeFile(path, snapshot.files[path]);
      for (const path of restorePlan.willDelete) removePath(path);
      toast.success(
        'Restored',
        `${restorePlan.willWrite.length} written, ${restorePlan.willDelete.length} removed.`,
      );
    } catch (error) {
      toast.error('Could not restore', errorMessage(error));
    } finally {
      setRestoring(false);
      setConfirming(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Timeline"
        actions={
          <>
            <IconButton
              label="Mark this point"
              size="xs"
              disabled={!Object.keys(files).length}
              icon={<Bookmark className="h-3.5 w-3.5" />}
              onClick={() => {
                const id = capture(files, 'manual', 'Marked by hand');
                if (id) toast.success('Point recorded');
                else toast.info('Nothing to record', 'A point was just taken, or the project is empty.');
              }}
            />
            {snapshots.length > 0 && (
              <IconButton
                label="Clear the timeline"
                size="xs"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={clear}
              />
            )}
          </>
        }
      />

      {/* Said at the top, because the phrase promises something this is not. */}
      <p className="shrink-0 border-b border-line px-2.5 py-1.5 text-sm text-ink-faint">
        <span>
          This records the project’s files at points that matter and the events around them. It is
          not execution replay — stepping an application backwards needs a runtime that re-drives
          it, and the preview is an ordinary sandboxed frame.
        </span>
      </p>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!snapshots.length ? (
          <EmptyState
            icon={<History className="h-4 w-4" />}
            title="No points recorded yet"
            description="A point is recorded before the assistant changes files, on a commit, or when you mark one."
          />
        ) : (
          snapshots.map((snapshot) => {
            const active = snapshot.id === selectedId;
            return (
              <div key={snapshot.id} className={cx('border-b border-line', active && 'bg-surface-sunken')}>
                <button
                  type="button"
                  aria-expanded={active}
                  onClick={() => {
                    setSelectedId(active ? null : snapshot.id);
                    setInspectPath(null);
                  }}
                  className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-surface-raised"
                >
                  <History aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-ink">{snapshot.label}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
                      <span>{REASON_LABEL[snapshot.reason]}</span>
                      <span>{formatTimeAgo(snapshot.at)}</span>
                      <span className="tabular-nums">
                        {Object.keys(snapshot.files).length} files
                      </span>
                    </span>
                  </span>
                </button>

                {active && comparison && (
                  <div className="px-2.5 pb-2">
                    {comparison.changes.length === 0 ? (
                      <p className="text-sm text-ink-faint">
                        <span>The project is unchanged since this point.</span>
                      </p>
                    ) : (
                      <>
                        <p className="panel-label">
                          {comparison.changes.length} file
                          {comparison.changes.length === 1 ? '' : 's'} differ
                        </p>
                        {comparison.changes.slice(0, 20).map((change) => (
                          <button
                            key={change.path}
                            type="button"
                            aria-current={inspectPath === change.path}
                            onClick={() =>
                              setInspectPath(inspectPath === change.path ? null : change.path)
                            }
                            className={cx(
                              'flex w-full items-center gap-1.5 px-0.5 py-0.5 text-left text-sm',
                              inspectPath === change.path ? 'text-ink' : 'text-ink-muted hover:text-ink',
                            )}
                          >
                            <FileIcon path={change.path} />
                            <span className="min-w-0 flex-1 truncate">{basename(change.path)}</span>
                            <span
                              className={cx(
                                'shrink-0 font-mono',
                                change.kind === 'added'
                                  ? 'text-positive'
                                  : change.kind === 'removed'
                                    ? 'text-danger'
                                    : 'text-caution',
                              )}
                            >
                              {change.kind[0].toUpperCase()}
                            </span>
                          </button>
                        ))}
                      </>
                    )}

                    {/* Named rather than counted as unchanged: there is no
                        recorded version to compare against. */}
                    {comparison.unknown.length > 0 && (
                      <p className="mt-1 text-sm text-caution">
                        <span>
                          {comparison.unknown.length} file
                          {comparison.unknown.length === 1 ? ' was' : 's were'} too large to record,
                          so no comparison exists for {comparison.unknown.length === 1 ? 'it' : 'them'}
                          : {comparison.unknown.slice(0, 3).join(', ')}
                          {comparison.unknown.length > 3 ? '…' : ''}
                        </span>
                      </p>
                    )}

                    {inspectPath && (
                      <div className="mt-1.5 h-56 overflow-hidden rounded border border-line">
                        <DiffViewer
                          before={snapshot.files[inspectPath] ?? ''}
                          after={files[inspectPath] ?? ''}
                          emptyLabel="No textual difference."
                        />
                      </div>
                    )}

                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Button
                        size="xs"
                        variant="danger"
                        disabled={!canWrite || restoring || comparison.changes.length === 0}
                        leading={<RotateCcw className="h-3 w-3" />}
                        onClick={() => setConfirming(snapshot)}
                      >
                        Restore this point
                      </Button>
                      <Button
                        size="xs"
                        disabled={running || comparison.changes.length === 0}
                        leading={<Sparkles className="h-3 w-3" />}
                        onClick={() => {
                          setSidebarPanel('assistant');
                          void send(divergencePrompt(snapshot, comparison.changes, eventsSince));
                        }}
                      >
                        What changed here?
                      </Button>
                      <Button size="xs" onClick={() => remove(snapshot.id)}>
                        Forget
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {snapshots.length > 0 && (
          <p className="px-2.5 py-2 text-sm text-ink-faint">
            <span>
              Up to {MAX_SNAPSHOTS} points are kept, in memory, for this session only. Recording a
              copy of the project on every keystroke would be the reason the editor was slow, and
              writing these to browser storage would leave your source there after you closed the
              tab.
            </span>
          </p>
        )}
      </div>

      {/* What a restore would do, before it does it. */}
      <Modal
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        title="Restore this point?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={restoring}
              onClick={() => confirming && void applyRestore(confirming)}
            >
              Restore
            </Button>
          </>
        }
      >
        {plan && (
          <div className="space-y-2">
            <p className="text-base text-ink">
              This overwrites the project with how it was {confirming ? formatTimeAgo(confirming.at) : ''}.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-faint">Written back</dt>
              <dd className="tabular-nums text-ink">{plan.willWrite.length} files</dd>
              <dt className="text-ink-faint">Deleted</dt>
              <dd className="tabular-nums text-danger">{plan.willDelete.length} files</dd>
            </dl>
            {plan.willDelete.length > 0 && (
              <p className="text-sm text-danger">
                <span>
                  Created since that point and will be removed: {plan.willDelete.slice(0, 5).join(', ')}
                  {plan.willDelete.length > 5 ? '…' : ''}
                </span>
              </p>
            )}
            {plan.cannotRestore.length > 0 && (
              <p className="text-sm text-caution">
                <span>
                  {plan.cannotRestore.length} file
                  {plan.cannotRestore.length === 1 ? '' : 's'} cannot be restored — too large to have
                  been recorded — and will keep their current contents:{' '}
                  {plan.cannotRestore.slice(0, 3).join(', ')}
                  {plan.cannotRestore.length > 3 ? '…' : ''}
                </span>
              </p>
            )}
            <p className="text-sm text-ink-faint">
              <span>A point is recorded before this happens, so it can be undone.</span>
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
