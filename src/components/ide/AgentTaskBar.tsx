import { useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  FileDiff,
  Loader2,
  ShieldAlert,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Primitives';
import { Modal } from '@/components/ui/Modal';
import { DiffViewer } from '@/components/ide/DiffViewer';
import { SEVERITY_LABELS, useAgentStore } from '@/stores/agentStore';
import { PHASE_LABELS, isActive, isTerminal } from '@/lib/ai/task';
import { useEditorStore } from '@/stores/editorStore';
import { cx } from '@/lib/utils';

/**
 * What the agent is doing, what it wants permission for, and what it changed.
 *
 * The phase comes from the task record rather than a spinner, so the panel can
 * never read "idle" while tools are running. The approval prompt blocks the
 * agent for real — the tool call is awaiting the answer, not proceeding
 * optimistically — and the change list opens the project's existing diff
 * viewer rather than a second, worse one.
 */
export function AgentTaskBar() {
  const task = useAgentStore((s) => s.task);
  const pending = useAgentStore((s) => s.pending);
  const resolveApproval = useAgentStore((s) => s.resolveApproval);
  const revealLocation = useEditorStore((s) => s.revealLocation);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  if (!task) return null;

  const active = isActive(task.phase);
  const change = task.changes.find((entry) => entry.path === diffPath) ?? null;

  return (
    <>
      <div className="border-b border-line">
        {/* Phase */}
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          {active ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          ) : task.phase === 'completed' ? (
            <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-positive" />
          ) : task.phase === 'cancelled' ? (
            <CircleSlash aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          ) : (
            <XCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-danger" />
          )}
          <p className="min-w-0 flex-1 truncate text-base text-ink" data-testid="agent-phase">
            {PHASE_LABELS[task.phase]}
          </p>
          {task.steps > 0 && <Badge>{task.steps} steps</Badge>}
        </div>

        {/* Plan */}
        {task.plan.length > 0 && (
          <details className="border-t border-line px-2.5 py-1.5" open={active}>
            <summary className="cursor-pointer text-sm text-ink-muted">
              Plan · {task.plan.length} steps
            </summary>
            <ol className="mt-1.5 space-y-0.5 pl-4 text-sm text-ink-faint">
              {task.plan.map((step, index) => (
                <li key={`${index}-${step.slice(0, 24)}`} className="list-decimal">
                  {step}
                </li>
              ))}
            </ol>
          </details>
        )}

        {/* Approval */}
        {pending && (
          <div
            role="alertdialog"
            aria-label="Approval required"
            className="border-t border-caution/40 bg-caution/5 p-2.5"
          >
            <p className="flex items-center gap-1.5 text-base text-ink">
              <ShieldAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-caution" />
              Approval required
              <Badge tone="caution">{SEVERITY_LABELS[pending.severity]}</Badge>
            </p>
            <dl className="mt-1.5 space-y-1 text-sm">
              <div>
                <dt className="text-ink-faint">What</dt>
                <dd className="font-mono text-ink">{pending.what}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Why</dt>
                <dd className="text-ink-muted">{pending.why}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Affects</dt>
                <dd className="font-mono text-ink-muted">{pending.affects.join(', ')}</dd>
              </div>
            </dl>
            <div className="mt-2 flex gap-1.5">
              <Button size="xs" variant="primary" onClick={() => resolveApproval(true)}>
                Approve
              </Button>
              <Button size="xs" onClick={() => resolveApproval(false)}>
                Decline
              </Button>
            </div>
          </div>
        )}

        {/* Verification evidence */}
        {task.verifications.length > 0 && (
          <div className="border-t border-line px-2.5 py-1.5">
            {task.verifications.map((check) => (
              <p key={check.name} className="flex items-center gap-1.5 text-sm">
                {check.ok ? (
                  <CheckCircle2 aria-hidden className="h-3 w-3 shrink-0 text-positive" />
                ) : (
                  <TriangleAlert aria-hidden className="h-3 w-3 shrink-0 text-danger" />
                )}
                <span className="text-ink-muted">
                  {check.name}: {check.detail}
                </span>
              </p>
            ))}
          </div>
        )}

        {/* Changed files */}
        {task.changes.length > 0 && (
          <div className="border-t border-line py-1">
            <p className="panel-label px-2.5 py-0.5">
              {task.changes.length} file{task.changes.length === 1 ? '' : 's'} changed
            </p>
            {task.changes.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => {
                  setDiffPath(entry.path);
                  if (entry.kind !== 'deleted') revealLocation(entry.path, 1);
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-surface-raised"
              >
                <FileDiff aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
                  {entry.path}
                </span>
                <span
                  className={cx(
                    'shrink-0 text-xs',
                    entry.kind === 'created'
                      ? 'text-positive'
                      : entry.kind === 'deleted'
                        ? 'text-danger'
                        : 'text-caution',
                  )}
                >
                  {entry.kind}
                </span>
                <ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
              </button>
            ))}
          </div>
        )}

        {/* Outcome */}
        {isTerminal(task.phase) && task.summary && (
          <p className="border-t border-line px-2.5 py-1.5 text-sm text-ink-muted">
            {task.summary}
          </p>
        )}
      </div>

      <Modal
        open={Boolean(change)}
        onClose={() => setDiffPath(null)}
        title={change?.path ?? ''}
        description={`What the agent changed in this task (${change?.kind}).`}
        size="lg"
        footer={<Button onClick={() => setDiffPath(null)}>Close</Button>}
      >
        {change && <DiffViewer before={change.before} after={change.after} />}
      </Modal>
    </>
  );
}
