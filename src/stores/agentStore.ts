import { create } from 'zustand';
import {
  classify,
  SEVERITY_LABELS,
  type ApprovalRequest,
} from '@/lib/ai/approval';
import {
  isTerminal,
  newTask,
  phaseForTool,
  recordChange,
  summarise,
  transition,
  type AgentTask,
  type FileChangeRecord,
  type TaskPhase,
  type VerificationResult,
} from '@/lib/ai/task';
import {
  newValidation,
  noteUserEdit,
  noteWrite,
  recordCheck,
  type ValidationState,
} from '@/lib/ai/validation';
import type { ChangePlan } from '@/lib/ai/plan';
import { ReadCache, detectStack, outlineOf, renderContext } from '@/lib/ai/context';
import { uid } from '@/lib/utils';
import { useTimeTravelStore } from '@/stores/timeTravelStore';
import { useFileStore } from '@/stores/fileStore';

/**
 * Task state for the coding agent.
 *
 * Kept separate from `aiStore`, which owns the provider connection and the
 * conversation. This store owns what the *task* is doing: which phase it is
 * in, what it has changed, what it is waiting on, and whether it may run at
 * all. Splitting them is what lets the panel report an accurate phase without
 * the chat transcript and the execution state fighting over one boolean.
 */

export interface PendingApproval extends ApprovalRequest {
  resolve: (granted: boolean) => void;
}

interface AgentState {
  task: AgentTask | null;
  /** Finished tasks, newest first, capped. */
  history: AgentTask[];
  pending: PendingApproval | null;
  /** Project the running task belongs to, for the concurrency guard. */
  lockedProjectId: string | null;

  begin: (request: string, projectId: string) => AgentTask | null;
  setPhase: (phase: TaskPhase) => void;
  setPlan: (plan: string[]) => void;
  noteActivityPhase: (tool: string) => void;
  noteCommand: (command: string) => void;
  noteChange: (
    path: string,
    kind: FileChangeRecord['kind'],
    before: string,
    after: string,
  ) => void;
  noteVerification: (result: VerificationResult) => void;
  /** The files the agent said it would touch, from `plan_changes`. */
  setChangePlan: (plan: ChangePlan) => void;
  /** A file changed outside the agent; its evidence expires too. */
  noteExternalEdit: (path: string) => void;
  /** Evidence for the running task: which checks ran, against which state. */
  validation: ValidationState;
  /** The last plan the agent stated, so the panel can show it against reality. */
  changePlan: ChangePlan | null;
  requestApproval: (action: string, affects: string[], tool: string, reason?: string) => Promise<boolean>;
  resolveApproval: (granted: boolean) => void;
  finish: (phase: 'completed' | 'failed' | 'cancelled', summary?: string) => void;
  clearHistory: () => void;
}

const MAX_HISTORY = 20;

/** Read cache for the running task. Cleared whenever a task starts. */
export const readCache = new ReadCache();

/**
 * Only one task may hold the workspace at a time.
 *
 * Two agents editing the same virtual file system would interleave writes and
 * leave the project in a state neither of them planned. The lock lives at
 * module scope so it survives re-renders.
 */
let activeProjectId: string | null = null;

export function agentLockHolder(): string | null {
  return activeProjectId;
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  task: null,
  history: [],
  pending: null,
  lockedProjectId: null,
  validation: newValidation(),
  changePlan: null,

  /** Returns null when another task already holds the workspace. */
  begin(request, projectId) {
    /*
     * The project as it was before the assistant touched it.
     *
     * Taken here rather than after, because the point of the record is to be
     * able to see what the agent changed — which needs the version from before
     * it started, not the one it left behind.
     */
    useTimeTravelStore
      .getState()
      .capture(useFileStore.getState().files, 'agent-task', request.slice(0, 80));
    if (activeProjectId) return null;
    activeProjectId = projectId;
    readCache.clear();
    const task = newTask(request, uid('task'));
    // A new task starts with no evidence. Carrying the last task's checks over
    // would let one task's passing build vouch for another task's edits.
    set({
      task,
      pending: null,
      lockedProjectId: projectId,
      validation: newValidation(),
      changePlan: null,
    });
    return task;
  },

  setPhase(phase) {
    const task = get().task;
    if (!task) return;
    set({ task: transition(task, phase) });
  },

  setPlan(plan) {
    const task = get().task;
    if (!task) return;
    set({ task: { ...task, plan } });
  },

  noteActivityPhase(tool) {
    const task = get().task;
    if (!task || isTerminal(task.phase)) return;
    set({ task: { ...transition(task, phaseForTool(tool)), steps: task.steps + 1 } });
  },

  noteCommand(command) {
    const task = get().task;
    if (!task) return;
    set({ task: { ...task, commands: [...task.commands, command] } });
  },

  noteChange(path, kind, before, after) {
    const task = get().task;
    if (!task) return;
    /*
     * The agent wrote these bytes, so it has read them.
     *
     * Invalidating unconditionally breaks the repair loop once a whole-file
     * write requires a current read: write, build fails, write the fix — and
     * the second write is refused because the first cleared the read record.
     * The agent could not fix its own mistake without re-reading a file it had
     * just authored.
     *
     * Recording the new content keeps the safety property exactly as it is.
     * The rule is "never overwrite content nobody has seen", and content the
     * agent just wrote is content the agent has seen. An edit by *somebody
     * else* still invalidates — that is `noteExternalEdit`, and it is what
     * protects the user's work.
     *
     * A deletion has no content to have read, so it still invalidates.
     */
    if (kind === 'deleted') readCache.invalidate(path);
    else readCache.record(path, after, false);
    set({
      task: { ...task, changes: recordChange(task.changes, { path, kind, before, after }) },
      // Every check taken before this write described a state that no longer
      // exists. Bumping the revision is what stops it being quoted as evidence.
      validation: noteWrite(get().validation, path),
    });
  },

  setChangePlan(plan) {
    if (!get().task) return;
    set({ changePlan: plan });
  },

  /**
   * A file changed underneath the agent, by the user or by anything else.
   *
   * Same invalidation as the agent's own write, because the files are equally
   * not what the check looked at. The agent does not see this happen, which is
   * exactly why the evidence has to expire rather than be trusted.
   */
  noteExternalEdit(path) {
    if (!get().task) return;
    set({ validation: noteUserEdit(get().validation, path) });
  },

  noteVerification(result) {
    const task = get().task;
    if (!task) return;
    set({
      task: {
        ...task,
        verifications: [...task.verifications.filter((v) => v.name !== result.name), result],
      },
      // Recorded against the revision it actually ran on, so a later edit can
      // make it stale rather than silently keeping it as proof.
      validation: recordCheck(get().validation, result),
    });
  },

  /**
   * Put an approval to the user and wait for it.
   *
   * The promise is held by the tool call, so the agent genuinely blocks rather
   * than proceeding optimistically. A cancelled task resolves it as declined,
   * which is what keeps cancellation from leaving a dangling await.
   */
  requestApproval(action, affects, tool, reason) {
    const task = get().task;
    if (!task || isTerminal(task.phase)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const severity = classify({ tool, input: {}, changedSoFar: task.changes.length }).request?.severity;
      set({
        task: transition(task, 'waiting_for_approval'),
        pending: {
          id: uid('appr'),
          tool,
          what: action,
          why: reason?.trim() || 'Requested as part of your task.',
          affects,
          severity: severity ?? 'destructive',
          resolve,
        },
      });
    });
  },

  resolveApproval(granted) {
    const pending = get().pending;
    if (!pending) return;
    pending.resolve(granted);
    const task = get().task;
    set({
      pending: null,
      // Approving resumes work; declining still needs a phase to sit in.
      task: task ? transition(task, granted ? 'editing' : 'inspecting') : task,
    });
  },

  finish(phase, summary) {
    const task = get().task;
    activeProjectId = null;
    // A task that ends while an approval is outstanding must not leave the
    // tool call awaiting a promise nobody will settle.
    const pending = get().pending;
    if (pending) pending.resolve(false);
    if (!task) {
      set({ pending: null, lockedProjectId: null });
      return;
    }
    const ended = {
      ...transition(task, phase),
      phase,
      endedAt: Date.now(),
      summary: summary || summarise(task),
    };
    set({
      task: ended,
      pending: null,
      lockedProjectId: null,
      history: [ended, ...get().history].slice(0, MAX_HISTORY),
    });
  },

  clearHistory: () => set({ history: [] }),
}));

export { SEVERITY_LABELS };

/** Build the compact project header the agent is given. */
export function projectContextHeader(input: {
  name: string;
  template: string;
  language: string;
  branch: string;
  files: Record<string, string>;
  dirty: string[];
  diagnostics: string[];
  terminals?: Array<{ name: string; environment: string; label: string }>;
}): string {
  const { framework, packageManager } = detectStack(input.files);
  return renderContext({
    name: input.name,
    template: input.template,
    language: input.language,
    framework,
    packageManager,
    branch: input.branch,
    dirty: input.dirty,
    diagnostics: input.diagnostics,
    fileCount: Object.keys(input.files).length,
    outline: outlineOf(input.files),
    terminals: input.terminals,
  });
}
