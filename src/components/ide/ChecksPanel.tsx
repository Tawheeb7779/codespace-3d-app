import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Play, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, Spinner } from '@/components/ui/Primitives';
import {
  subscribeWorkspace,
  workspaceCheck,
  workspaceConnected,
  workspaceContainerId,
} from '@/lib/ai/workspaceBridge';
import { useCheckStore } from '@/stores/checkStore';
import { cx } from '@/lib/utils';

/**
 * The project's own checks, run in its container, for a person.
 *
 * The agent gained this in Phase 3 and it would be strange for the person whose
 * project it is to have less: the same five-name allowlist, the same gateway,
 * the same real `npm run`. Nothing here is a second implementation — the button
 * sends the same `check` frame the agent's tool does.
 *
 * **It is not a shell.** The list is what the gateway said this project defines
 * among `test`, `lint`, `typecheck`, `build` and `verify`. There is no field to
 * type a command into, because the request carries a script *name* and the
 * gateway decides what that runs. A project that defines none gets an empty
 * list rather than a text box.
 *
 * **A failing check reads as failing.** The exit code and the real output are
 * shown as they came back. An IDE that summarised a red suite as "checks ran"
 * would be the same lie as an agent claiming a verification it never performed.
 */

interface Outcome {
  script: string;
  ok: boolean;
  exitCode: number;
  output: string;
  truncated: boolean;
}

export function ChecksPanel() {
  const connected = useSyncExternalStore(subscribeWorkspace, workspaceConnected, () => false);
  const containerId = useSyncExternalStore(subscribeWorkspace, workspaceContainerId, () => null);

  const [available, setAvailable] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Ask the workspace what it can run. One request, when the panel opens. */
  const list = useCallback(async () => {
    setListing(true);
    setError(null);
    try {
      const answer = await workspaceCheck({ op: 'list' });
      if (answer.ok) setAvailable(answer.available ?? []);
      else setError(answer.message ?? 'The workspace could not list its checks.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The workspace did not answer.');
    } finally {
      setListing(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setAvailable(null);
      setOutcome(null);
      setError(null);
      return;
    }
    void list();
  }, [connected, containerId, list]);

  async function run(script: string) {
    setRunning(script);
    setOutcome(null);
    setError(null);
    try {
      const answer = await workspaceCheck({ op: 'run', script });
      // A refusal is a refusal: the gateway declining `deploy` is not a check
      // that passed, and must not be shown as one.
      if (!answer.ok) setError(answer.message ?? `${script} could not be run.`);
      else if (answer.result) {
        setOutcome(answer.result);
        // Remembered beyond this panel, so the health dashboard can report a
        // real exit code rather than assuming one.
        useCheckStore.getState().record({
          script: answer.result.script,
          ok: answer.result.ok,
          exitCode: answer.result.exitCode,
          summary: answer.result.output,
        });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The workspace did not answer.');
    } finally {
      setRunning(null);
    }
  }

  if (!connected) {
    return (
      <EmptyState
        title="No container workspace attached"
        description="Open the project terminal to attach this project's container. Checks run there, as real processes."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        {listing && available === null ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : available && available.length ? (
          available.map((script) => (
            <Button
              key={script}
              size="xs"
              disabled={running !== null}
              loading={running === script}
              leading={<Play className="h-3 w-3" />}
              onClick={() => void run(script)}
            >
              {script}
            </Button>
          ))
        ) : (
          <p className="text-sm text-ink-faint">
            <span>
              This project defines none of the checks this workspace will run (test, lint,
              typecheck, build, verify).
            </span>
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="border-b border-danger/40 bg-danger/5 px-2.5 py-1 text-sm text-danger">
          <span>{error}</span>
        </p>
      )}

      {outcome ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1">
            {outcome.ok ? (
              <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-positive" />
            ) : (
              <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-danger" />
            )}
            <span className={cx('text-base', outcome.ok ? 'text-positive' : 'text-danger')}>
              {`npm run ${outcome.script} — ${outcome.ok ? 'passed' : 'FAILED'}`}
            </span>
            <span className="font-mono text-sm tabular-nums text-ink-faint">
              {`exit ${outcome.exitCode}`}
            </span>
            {outcome.truncated && (
              <span className="ml-auto text-sm text-ink-faint">
                <span>output truncated</span>
              </span>
            )}
          </div>
          <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-surface-sunken p-2 font-mono text-sm leading-5 text-ink-muted">
            {outcome.output || '(no output)'}
          </pre>
        </div>
      ) : (
        <EmptyState
          title={running ? `Running ${running}…` : 'No check run yet'}
          description={
            running
              ? 'This is a real process in the container, so it takes as long as it takes.'
              : 'Run one of the project’s checks above. The exit code and output are shown exactly as they came back.'
          }
        />
      )}
    </div>
  );
}
