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
import { ReadCache, detectStack, outlineOf, renderContext } from '@/lib/ai/context';
import { uid } from '@/lib/utils';

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

  /** Returns null when another task already holds the workspace. */
  begin(request, projectId) {
    if (activeProjectId) return null;
    activeProjectId = projectId;
    readCache.clear();
    const task = newTask(request, uid('task'));
    set({ task, pending: null, lockedProjectId: projectId });
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
    // The file moved on, so the agent must be shown the new content next time.
    readCache.invalidate(path);
    set({ task: { ...task, changes: recordChange(task.changes, { path, kind, before, after }) } });
  },

  noteVerification(result) {
    const task = get().task;
    if (!task) return;
    set({
      task: {
        ...task,
        verifications: [...task.verifications.filter((v) => v.name !== result.name), result],
      },
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
  });
}
