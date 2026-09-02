import type { AgentActivity } from '@/lib/ai/agent';

/**
 * The agent task lifecycle.
 *
 * The panel reads its state from here rather than from a boolean, so it can
 * never show "idle" while tools are running — which is the failure mode that
 * makes an agent feel untrustworthy. Transitions are validated: a task that
 * has completed, failed or been cancelled is terminal, and nothing can move it
 * back into a working phase.
 */

export type TaskPhase =
  | 'idle'
  | 'planning'
  | 'reading'
  | 'editing'
  | 'running'
  | 'inspecting'
  | 'waiting_for_approval'
  | 'fixing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_PHASES: TaskPhase[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** Phases in which the agent is doing something the user should see. */
export function isActive(phase: TaskPhase): boolean {
  return phase !== 'idle' && !isTerminal(phase);
}

export const PHASE_LABELS: Record<TaskPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  reading: 'Reading the project',
  editing: 'Editing files',
  running: 'Running a command',
  inspecting: 'Inspecting results',
  waiting_for_approval: 'Waiting for your approval',
  fixing: 'Fixing a failure',
  verifying: 'Verifying the change',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Which phase a tool call puts the task into.
 *
 * Derived from the tool rather than announced by the model: a model that says
 * "now editing" while calling `read_file` would otherwise mislabel the state.
 */
export function phaseForTool(tool: string): TaskPhase {
  switch (tool) {
    case 'read_file':
    case 'list_files':
    case 'get_project_structure':
    case 'search_files':
      return 'reading';
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return 'editing';
    case 'run_command':
      return 'running';
    case 'run_build':
    case 'get_diagnostics':
      return 'verifying';
    case 'get_terminal_output':
      return 'inspecting';
    default:
      return 'running';
  }
}

/** One file the agent changed, with enough history to diff and to undo. */
export interface FileChangeRecord {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  /** Content before the agent's first touch. Empty string for a creation. */
  before: string;
  /** Content after the agent's most recent touch. Empty for a deletion. */
  after: string;
  touches: number;
}

/**
 * Fold a new change into the ledger.
 *
 * The `before` of the first touch is preserved across later edits, so the diff
 * the user reviews is "what this task did", not "what the last tool call did".
 * A file created and then deleted within one task cancels out entirely.
 */
export function recordChange(
  ledger: FileChangeRecord[],
  change: { path: string; kind: FileChangeRecord['kind']; before: string; after: string },
): FileChangeRecord[] {
  const existing = ledger.find((entry) => entry.path === change.path);
  if (!existing) {
    return [...ledger, { ...change, touches: 1 }];
  }
  // Created during this task and now deleted: it never existed for the user.
  if (existing.kind === 'created' && change.kind === 'deleted') {
    return ledger.filter((entry) => entry.path !== change.path);
  }
  const kind: FileChangeRecord['kind'] =
    change.kind === 'deleted' ? 'deleted' : existing.kind === 'created' ? 'created' : 'modified';
  return ledger.map((entry) =>
    entry.path === change.path
      ? { ...entry, kind, after: change.after, touches: entry.touches + 1 }
      : entry,
  );
}

export interface VerificationResult {
  name: string;
  ok: boolean;
  detail: string;
  /** When false, the check could not run here rather than having failed. */
  ran: boolean;
}

export interface AgentTask {
  id: string;
  request: string;
  phase: TaskPhase;
  /** The agent's stated plan, when it produced one before acting. */
  plan: string[];
  activities: AgentActivity[];
  changes: FileChangeRecord[];
  verifications: VerificationResult[];
  /** Commands actually executed, for the history record. */
  commands: string[];
  startedAt: number;
  endedAt: number | null;
  /** Set on failure or cancellation. */
  summary: string;
  steps: number;
}

export function newTask(request: string, id: string): AgentTask {
  return {
    id,
    request,
    phase: 'planning',
    plan: [],
    activities: [],
    changes: [],
    verifications: [],
    commands: [],
    startedAt: Date.now(),
    endedAt: null,
    summary: '',
    steps: 0,
  };
}

/**
 * Move a task to a new phase, refusing transitions that would misreport it.
 *
 * A terminal task never reopens: a late tool result arriving after the user
 * cancelled must not put the panel back into "running".
 */
export function transition(task: AgentTask, phase: TaskPhase): AgentTask {
  if (isTerminal(task.phase)) return task;
  if (task.phase === phase) return task;
  return {
    ...task,
    phase,
    endedAt: isTerminal(phase) ? Date.now() : task.endedAt,
  };
}

/**
 * A one-line, honest account of what a finished task did.
 *
 * Deliberately built from the ledger rather than from the model's prose: the
 * model can claim it edited a file, the ledger only contains files a tool call
 * actually changed.
 */
export function summarise(task: AgentTask): string {
  const parts: string[] = [];
  const created = task.changes.filter((c) => c.kind === 'created').length;
  const modified = task.changes.filter((c) => c.kind === 'modified').length;
  const deleted = task.changes.filter((c) => c.kind === 'deleted').length;
  if (created) parts.push(`${created} created`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  if (task.commands.length) parts.push(`${task.commands.length} command(s) run`);

  const checks = task.verifications.filter((v) => v.ran);
  if (checks.length) {
    const failed = checks.filter((v) => !v.ok).length;
    parts.push(failed ? `${failed}/${checks.length} checks failed` : `${checks.length} checks passed`);
  }
  if (!parts.length) return 'No changes were made.';
  return parts.join(', ');
}
