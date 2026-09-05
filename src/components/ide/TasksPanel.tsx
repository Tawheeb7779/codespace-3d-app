import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleSlash,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  Square,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Field';
import { useTaskStore } from '@/stores/taskStore';
import { useFileStore } from '@/stores/fileStore';
import { toast } from '@/stores/toastStore';
import {
  STATE_LABELS,
  durationOf,
  formatDuration,
  isFinished,
  type RunConfiguration,
  type TaskKind,
  type TaskRun,
} from '@/lib/tasks';
import { cx, errorMessage, formatTimeAgo } from '@/lib/utils';

/**
 * Run configurations and their results.
 *
 * Every state shown here comes from a run that actually happened: `succeeded`
 * means the command returned zero, `failed` means it did not. The panel is
 * also where the debugging story is told honestly — Forge builds and runs a
 * project in a sandboxed frame, which gives real output and real error
 * locations, but no paused execution. Saying so is better than a breakpoint
 * gutter that would never stop anything.
 */

const KIND_LABELS: Record<TaskKind, string> = {
  build: 'Build',
  run: 'Run',
  test: 'Test',
  lint: 'Lint',
  custom: 'Custom',
};

function StateIcon({ state }: { state: TaskRun['state'] }) {
  if (state === 'running') {
    return <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  }
  if (state === 'succeeded') {
    return <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-positive" />;
  }
  if (state === 'failed') return <XCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-danger" />;
  if (state === 'cancelled') {
    return <CircleSlash aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />;
  }
  return <span aria-hidden className="h-3.5 w-3.5 shrink-0 text-center text-ink-faint">·</span>;
}

interface DraftState {
  id: string | null;
  name: string;
  kind: TaskKind;
  command: string;
  cwd: string;
  envNames: string;
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: '',
  kind: 'custom',
  command: '',
  cwd: '',
  envNames: '',
};

export function TasksPanel() {
  const configs = useTaskStore((s) => s.configs);
  const runs = useTaskStore((s) => s.runs);
  const activeRunId = useTaskStore((s) => s.activeRunId);
  const ensureDefaults = useTaskStore((s) => s.ensureDefaults);
  const start = useTaskStore((s) => s.start);
  const cancel = useTaskStore((s) => s.cancel);
  const addConfig = useTaskStore((s) => s.addConfig);
  const updateConfig = useTaskStore((s) => s.updateConfig);
  const removeConfig = useTaskStore((s) => s.removeConfig);
  const setDefaultConfig = useTaskStore((s) => s.setDefaultConfig);
  const clearHistory = useTaskStore((s) => s.clearHistory);
  const canWrite = useFileStore((s) => s.canWrite());

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RunConfiguration | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  useEffect(() => {
    ensureDefaults();
  }, [ensureDefaults]);

  const busy = activeRunId !== null;
  const queued = useMemo(() => runs.filter((run) => run.state === 'queued'), [runs]);
  const detail = runs.find((run) => run.id === openRun) ?? null;

  const guard = (label: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      toast.error(label, errorMessage(error));
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const envNames = draft.envNames
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    guard('Could not save the task', () => {
      if (draft.id) {
        updateConfig(draft.id, {
          name: draft.name,
          kind: draft.kind,
          command: draft.command,
          cwd: draft.cwd,
          envNames,
        });
      } else {
        addConfig({
          name: draft.name,
          kind: draft.kind,
          command: draft.command,
          cwd: draft.cwd,
          envNames,
        });
      }
      setDraft(null);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Tasks"
        actions={
          <IconButton
            label="New task"
            icon={<Plus className="h-3.5 w-3.5" />}
            disabled={!canWrite}
            onClick={() => setDraft(EMPTY_DRAFT)}
          />
        }
      />

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {/* Configurations */}
        <section className="border-b border-line py-1">
          <p className="panel-label px-2.5 py-1">Run configurations</p>
          {configs.map((config) => (
            <div key={config.id} className="flex items-center gap-1.5 px-2.5 py-1">
              <IconButton
                size="xs"
                label={`Run ${config.name}`}
                icon={<Play className="h-3 w-3" />}
                disabled={busy}
                onClick={() =>
                  void start(config.id).catch((error) =>
                    toast.error('Could not start the task', errorMessage(error)),
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-base text-ink">{config.name}</span>
                  {config.isDefault && <Badge tone="accent">default</Badge>}
                  <Badge>{KIND_LABELS[config.kind]}</Badge>
                </span>
                <span className="block truncate font-mono text-sm text-ink-faint">
                  {config.command}
                  {config.cwd && ` · in ${config.cwd}`}
                </span>
                {config.envNames.length > 0 && (
                  <span className="block truncate text-sm text-ink-faint">
                    needs {config.envNames.join(', ')} (names only — values are never stored)
                  </span>
                )}
              </span>
              <IconButton
                size="xs"
                label={`Make ${config.name} the default`}
                icon={<Star className={cx('h-3 w-3', config.isDefault && 'fill-accent text-accent')} />}
                onClick={() => setDefaultConfig(config.id)}
              />
              <IconButton
                size="xs"
                label={`Edit ${config.name}`}
                icon={<Pencil className="h-3 w-3" />}
                onClick={() =>
                  setDraft({
                    id: config.id,
                    name: config.name,
                    kind: config.kind,
                    command: config.command,
                    cwd: config.cwd,
                    envNames: config.envNames.join(', '),
                  })
                }
              />
              <IconButton
                size="xs"
                label={`Delete ${config.name}`}
                icon={<Trash2 className="h-3 w-3" />}
                disabled={config.builtIn}
                onClick={() => setConfirmDelete(config)}
              />
            </div>
          ))}
        </section>

        {/* Runs */}
        <section className="border-b border-line py-1">
          <p className="panel-label flex items-center gap-2 px-2.5 py-1">
            <span>Runs</span>
            {queued.length > 0 && <Badge>{queued.length} queued</Badge>}
          </p>
          {!runs.length ? (
            <EmptyState title="Nothing has run yet" description="Start a task to see its output." />
          ) : (
            runs.map((run) => {
              const elapsed = durationOf(run);
              return (
                <div key={run.id} className="flex items-center gap-1.5 px-2.5 py-1">
                  <StateIcon state={run.state} />
                  <button
                    type="button"
                    onClick={() => setOpenRun(run.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-base text-ink">{run.name}</span>
                    <span className="block truncate text-sm text-ink-faint">
                      {STATE_LABELS[run.state]}
                      {run.exitCode !== null && ` · exit ${run.exitCode}`}
                      {elapsed !== null && ` · ${formatDuration(elapsed)}`}
                      {run.endedAt && ` · ${formatTimeAgo(run.endedAt)}`}
                    </span>
                  </button>
                  {!isFinished(run.state) && (
                    <IconButton
                      size="xs"
                      label={`Cancel ${run.name}`}
                      icon={<Square className="h-3 w-3" />}
                      onClick={() => cancel(run.id)}
                    />
                  )}
                </div>
              );
            })
          )}
          {runs.some((run) => isFinished(run.state)) && (
            <div className="px-2.5 py-1">
              <Button size="xs" onClick={clearHistory}>
                Clear finished runs
              </Button>
            </div>
          )}
        </section>

        {/* What debugging means here */}
        <section className="p-2.5">
          <p className="flex items-start gap-1.5 text-sm text-ink-faint">
            <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Tasks run through the project shell, against this project&rsquo;s virtual files —
              never your machine. There is no step debugger: the preview reports real runtime
              errors with their location in Problems and Output, but execution cannot be paused.
            </span>
          </p>
        </section>
      </div>

      {/* Run output */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setOpenRun(null)}
        title={detail ? `${detail.name} — ${STATE_LABELS[detail.state]}` : ''}
        description={detail?.command}
        size="lg"
        footer={<Button onClick={() => setOpenRun(null)}>Close</Button>}
      >
        {detail && (
          <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-sunken p-2 font-mono text-sm text-ink-muted">
            {detail.output.length ? detail.output.join('\n') : 'This run produced no output.'}
          </pre>
        )}
      </Modal>

      {/* Configuration editor */}
      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit task' : 'New task'}
        description="Tasks run one command through the project shell. Chaining and redirection are not supported."
        size="md"
        footer={
          <>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveDraft}>
              Save task
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            <Input
              label="Name"
              autoFocus
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Type check"
            />
            <Select
              label="Kind"
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as TaskKind })}
              options={(Object.keys(KIND_LABELS) as TaskKind[]).map((value) => ({
                value,
                label: KIND_LABELS[value],
              }))}
            />
            <Input
              label="Command"
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              placeholder="build"
              hint="One command from the project shell. Run `help` in the terminal to see them."
            />
            <Input
              label="Working directory"
              value={draft.cwd}
              onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
              placeholder="(project root)"
            />
            <Input
              label="Environment variable names"
              value={draft.envNames}
              onChange={(event) => setDraft({ ...draft, envNames: event.target.value })}
              placeholder="API_URL, NODE_ENV"
              hint="Names only, comma separated. Values are never stored in a task — a value typed here is refused."
            />
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete task"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) guard('Could not delete the task', () => removeConfig(target.id));
              }}
            >
              Delete task
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          Delete <span className="font-medium">{confirmDelete?.name}</span>? Runs already recorded
          stay in the history.
        </p>
      </Modal>
    </div>
  );
}
