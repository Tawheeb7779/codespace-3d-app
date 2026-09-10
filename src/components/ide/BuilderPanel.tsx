import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Hammer, ListChecks, TriangleAlert } from 'lucide-react';
import { PanelHeader, EmptyState, Badge, Spinner } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ide/FileIcon';
import { useAiStore } from '@/stores/aiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useEditorStore } from '@/stores/editorStore';
import { workspaceConnected } from '@/lib/ai/workspaceBridge';
import {
  buildPrompt,
  parsePlan,
  planPrompt,
  summarise,
  type BuilderPhase,
  type PlanStep,
} from '@/lib/ai/builder';
import { basename } from '@/lib/vfs';
import { cx } from '@/lib/utils';

/**
 * Describing something and having the assistant build it.
 *
 * Two turns of the ordinary agent, with a person in between. The first reads
 * the project and writes a plan and is explicitly told to change nothing; the
 * plan appears here; only when somebody approves it does the second turn run.
 * A builder that starts editing on the first message is one that cannot be
 * stopped in time.
 *
 * Everything underneath is the assistant panel's: the same tools, the same
 * approval prompt before a destructive change, the same change ledger. There is
 * no second execution path, because a second path would be a second set of
 * rules.
 *
 * The result is read from what the agent recorded — files it changed, checks it
 * ran — never from the plan. A step that was planned and not carried out must
 * not appear as done.
 */
export function BuilderPanel() {
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const messages = useAiStore((s) => s.messages);
  const provider = useAiStore((s) => s.provider);
  const apiKeyPresent = useAiStore((s) => s.apiKeyPresent);
  const task = useAgentStore((s) => s.task);
  const reveal = useEditorStore((s) => s.revealLocation);

  const [request, setRequest] = useState('');
  const [phase, setPhase] = useState<BuilderPhase>('idle');
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [planReply, setPlanReply] = useState('');

  /** The reply this panel is waiting for, so an unrelated turn is ignored. */
  const awaiting = useRef<'plan' | 'build' | null>(null);

  const connected = provider.kind !== 'none' && (provider.kind === 'openai' || apiKeyPresent);
  const hasContainer = workspaceConnected();

  /*
   * Read the answer when the turn settles.
   *
   * `running` going false with a settled assistant message is the finished
   * turn. The ref makes sure a message from the assistant panel — somebody
   * typing there while this is open — is not mistaken for this panel's answer.
   */
  useEffect(() => {
    if (running || !awaiting.current) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.text.trim()) return;

    if (awaiting.current === 'plan') {
      const parsed = parsePlan(last.text);
      setPlanReply(last.text);
      setSteps(parsed);
      // No PLAN: lines means no plan. Inventing one from prose would put words
      // in the agent's mouth and then ask somebody to approve them.
      setPhase(parsed.length ? 'review' : 'idle');
    } else {
      setPhase('done');
    }
    awaiting.current = null;
  }, [running, messages]);

  const startPlanning = () => {
    if (!request.trim()) return;
    setSteps([]);
    setPlanReply('');
    setPhase('planning');
    awaiting.current = 'plan';
    void send(planPrompt(request, hasContainer));
  };

  const startBuilding = () => {
    setPhase('building');
    awaiting.current = 'build';
    void send(buildPrompt(request, steps, hasContainer));
  };

  const outcome = task
    ? {
        changed: task.changes.map((change) => ({ path: change.path, kind: change.kind })),
        verified: task.verifications.map((entry) => ({
          name: entry.name,
          ok: entry.ok,
          detail: entry.detail ?? '',
        })),
      }
    : { changed: [], verified: [] };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Build"
        actions={phase !== 'idle' ? <Badge tone={phase === 'done' ? 'positive' : 'accent'}>{phase}</Badge> : null}
      />

      {!connected ? (
        <EmptyState
          icon={<Hammer className="h-4 w-4" />}
          title="No assistant connected"
          description="Connect a provider in the Assistant panel. This uses the same agent — it has no model of its own."
        />
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line p-2.5">
            <p className="panel-label">What should it build?</p>
            <textarea
              aria-label="What to build"
              value={request}
              rows={3}
              disabled={running}
              placeholder="A settings page with a dark-mode toggle that persists"
              onChange={(event) => setRequest(event.target.value)}
              className="mt-1 w-full resize-y rounded border border-line bg-surface-sunken p-1.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="primary"
                loading={phase === 'planning'}
                disabled={running || !request.trim()}
                leading={<ListChecks className="h-3.5 w-3.5" />}
                onClick={startPlanning}
              >
                Plan it
              </Button>
              {phase !== 'idle' && (
                <Button
                  size="sm"
                  disabled={running}
                  onClick={() => {
                    setPhase('idle');
                    setSteps([]);
                    awaiting.current = null;
                  }}
                >
                  Start over
                </Button>
              )}
            </div>
            {/* Said before the plan is asked for, so it shapes the plan. */}
            <p className="mt-1.5 text-sm text-ink-faint">
              <span>
                {hasContainer
                  ? 'A container workspace is attached, so the assistant can run this project’s real checks.'
                  : 'No container workspace is attached, so the assistant cannot run this project’s tests. It will be told to say so rather than assume.'}
              </span>
            </p>
          </div>

          {phase === 'planning' && (
            <p className="flex items-center gap-2 px-2.5 py-3 text-sm text-ink-faint">
              <Spinner className="h-3 w-3" />
              <span>Reading the project and writing a plan. Nothing is being changed.</span>
            </p>
          )}

          {phase === 'idle' && planReply && (
            <div className="border-b border-line px-2.5 py-2">
              <p className="text-sm text-caution">
                <span>
                  The assistant did not produce a numbered plan. Its answer is below — try again
                  with a more specific request.
                </span>
              </p>
              <pre className="scrollbar-thin mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface-sunken p-1.5 text-sm text-ink-muted">
                {planReply}
              </pre>
            </div>
          )}

          {(phase === 'review' || phase === 'building' || phase === 'done') && steps.length > 0 && (
            <section className="border-b border-line px-2.5 py-2">
              <p className="panel-label">The plan</p>
              <ol className="mt-1 space-y-0.5">
                {steps.map((step) => (
                  <li key={step.index} className="flex gap-1.5 text-base text-ink-muted">
                    <span className="shrink-0 tabular-nums text-ink-faint">{step.index}.</span>
                    <span className="min-w-0 flex-1">{step.text}</span>
                  </li>
                ))}
              </ol>

              {phase === 'review' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="primary" leading={<Hammer className="h-3.5 w-3.5" />} onClick={startBuilding}>
                    Build this
                  </Button>
                  <Button size="sm" onClick={startPlanning}>
                    Plan again
                  </Button>
                </div>
              )}
            </section>
          )}

          {phase === 'building' && (
            <p className="flex items-center gap-2 px-2.5 py-3 text-sm text-ink-faint">
              <Spinner className="h-3 w-3" />
              <span>
                Building. Destructive changes will ask you first — the approval appears in the
                Assistant panel.
              </span>
            </p>
          )}

          {phase === 'done' && (
            <section className="px-2.5 py-2">
              <p className="panel-label">What actually happened</p>
              {/* From the agent's records, never from the plan. */}
              <p className="mt-0.5 text-base text-ink">{summarise(outcome)}</p>

              {outcome.changed.length > 0 && (
                <div className="mt-1.5">
                  <p className="panel-label">Files changed</p>
                  {outcome.changed.map((change) => (
                    <button
                      key={change.path}
                      type="button"
                      onClick={() => reveal(change.path, 1, 1)}
                      className="flex w-full items-center gap-1.5 py-0.5 text-left text-sm text-ink-muted hover:text-ink"
                    >
                      <FileIcon path={change.path} />
                      <span className="min-w-0 flex-1 truncate">{basename(change.path)}</span>
                      <span className="shrink-0 text-ink-faint">{change.kind}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-1.5">
                <p className="panel-label">Verified</p>
                {outcome.verified.length === 0 ? (
                  <p className="flex items-start gap-1.5 text-sm text-caution">
                    <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Nothing was run against this, so nothing here is known to work — only that it
                      was written.
                    </span>
                  </p>
                ) : (
                  outcome.verified.map((entry) => (
                    <p key={entry.name} className="flex items-center gap-1.5 text-sm">
                      {entry.ok ? (
                        <CheckCircle2 aria-hidden className="h-3 w-3 shrink-0 text-positive" />
                      ) : (
                        <TriangleAlert aria-hidden className="h-3 w-3 shrink-0 text-danger" />
                      )}
                      <span className={cx(entry.ok ? 'text-ink-muted' : 'text-danger')}>
                        {entry.name}: {entry.detail}
                      </span>
                    </p>
                  ))
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
