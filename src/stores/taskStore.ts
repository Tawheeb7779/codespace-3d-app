import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MAX_TASK_OUTPUT,
  defaultConfigurations,
  isFinished,
  validateCommand,
  validateCwd,
  validateEnvNames,
  validateTaskName,
  type RunConfiguration,
  type TaskKind,
  type TaskRun,
} from '@/lib/tasks';
import { execute, type ShellSession } from '@/lib/shell';
import { createShellHost } from '@/lib/shellHost';
import { useTerminalStore } from '@/stores/terminalStore';
import { uid } from '@/lib/utils';

/**
 * Named tasks over the existing project shell.
 *
 * There is no second runtime here: a task calls `execute`, exactly as the
 * terminal does, so it inherits the virtual file system, the command
 * allowlist and the absence of any host access. Output is mirrored into the
 * terminal so a run is never something the user can only see in one place.
 *
 * One run at a time, deliberately. The commands a task can start — `build`,
 * `run`, `npm` — mutate shared project state, and two of them interleaving
 * would produce a result neither asked for. Anything started while a run is
 * in flight is queued rather than dropped.
 */

/** Finished runs kept for the history view. */
export const MAX_RUN_HISTORY = 30;

interface TaskState {
  configs: RunConfiguration[];
  runs: TaskRun[];
  /** Ids waiting for the active run to finish, oldest first. */
  queue: string[];
  activeRunId: string | null;

  ensureDefaults: () => void;
  addConfig: (input: {
    name: string;
    kind: TaskKind;
    command: string;
    cwd?: string;
    envNames?: string[];
  }) => RunConfiguration;
  updateConfig: (id: string, patch: Partial<Omit<RunConfiguration, 'id' | 'builtIn'>>) => void;
  removeConfig: (id: string) => void;
  setDefaultConfig: (id: string) => void;

  start: (configId: string) => Promise<void>;
  cancel: (runId: string) => void;
  clearHistory: () => void;
  activeRun: () => TaskRun | null;
}

/**
 * Cancellation flags, at module scope.
 *
 * A run cannot be interrupted mid-command — the shell has no abort — so
 * cancelling marks the run and the loop refuses to record its result. Living
 * outside the store keeps this correct across re-renders.
 */
const cancelled = new Set<string>();

function trimOutput(lines: string[]): string[] {
  return lines.length > MAX_TASK_OUTPUT ? lines.slice(-MAX_TASK_OUTPUT) : lines;
}

export const useTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      configs: [],
      runs: [],
      queue: [],
      activeRunId: null,

      /** Seed the built-ins once, without disturbing anything the user added. */
      ensureDefaults() {
        if (get().configs.some((config) => config.builtIn)) return;
        set((state) => ({
          configs: [
            ...defaultConfigurations().map((config) => ({ ...config, id: uid('cfg') })),
            ...state.configs,
          ],
        }));
      },

      addConfig({ name, kind, command, cwd = '', envNames = [] }) {
        const config: RunConfiguration = {
          id: uid('cfg'),
          name: validateTaskName(name),
          kind,
          command: validateCommand(command),
          cwd: validateCwd(cwd),
          envNames: validateEnvNames(envNames),
          isDefault: false,
          builtIn: false,
        };
        set((state) => ({ configs: [...state.configs, config] }));
        return config;
      },

      updateConfig(id, patch) {
        set((state) => ({
          configs: state.configs.map((config) => {
            if (config.id !== id) return config;
            return {
              ...config,
              ...patch,
              // Re-validate whatever changed: a stored configuration decides
              // what runs, so it is checked on the way in every time.
              name: patch.name === undefined ? config.name : validateTaskName(patch.name),
              command:
                patch.command === undefined ? config.command : validateCommand(patch.command),
              cwd: patch.cwd === undefined ? config.cwd : validateCwd(patch.cwd),
              envNames:
                patch.envNames === undefined
                  ? config.envNames
                  : validateEnvNames(patch.envNames),
            };
          }),
        }));
      },

      removeConfig(id) {
        const config = get().configs.find((entry) => entry.id === id);
        if (config?.builtIn) throw new Error('Built-in tasks cannot be deleted.');
        set((state) => ({ configs: state.configs.filter((entry) => entry.id !== id) }));
      },

      setDefaultConfig(id) {
        set((state) => ({
          configs: state.configs.map((config) => ({ ...config, isDefault: config.id === id })),
        }));
      },

      /**
       * Run a configuration, queueing behind anything already in flight.
       *
       * Resolves when *this* run settles, so a caller can await a task without
       * having to know whether it waited first.
       */
      async start(configId) {
        const config = get().configs.find((entry) => entry.id === configId);
        if (!config) throw new Error('That task no longer exists.');

        const run: TaskRun = {
          id: uid('run'),
          configId,
          name: config.name,
          command: config.command,
          state: 'queued',
          output: [],
          exitCode: null,
          startedAt: null,
          endedAt: null,
        };
        set((state) => ({
          runs: [run, ...state.runs].slice(0, MAX_RUN_HISTORY),
          queue: [...state.queue, run.id],
        }));

        await drain();
      },

      cancel(runId) {
        cancelled.add(runId);
        const run = get().runs.find((entry) => entry.id === runId);
        if (!run || isFinished(run.state)) return;
        // A queued run never started, so it settles immediately. A running one
        // is marked here and the loop declines to record its outcome.
        patchRun(set, runId, { state: 'cancelled', endedAt: Date.now() });
        set((state) => ({
          queue: state.queue.filter((id) => id !== runId),
          activeRunId: state.activeRunId === runId ? null : state.activeRunId,
        }));
      },

      clearHistory: () =>
        set((state) => ({
          // Anything still queued or running stays; only settled runs clear.
          runs: state.runs.filter((run) => !isFinished(run.state)),
        })),

      activeRun: () => {
        const { runs, activeRunId } = get();
        return runs.find((run) => run.id === activeRunId) ?? null;
      },
    }),
    {
      name: 'forge.tasks',
      version: 1,
      // Only configurations persist. Runs are session history: reloading and
      // seeing a "running" task that is not running would be a lie.
      partialize: (state) => ({ configs: state.configs }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<TaskState>;
        return {
          ...current,
          // Corrupted or hand-edited storage must not decide what runs: every
          // stored configuration is re-validated, and anything invalid is
          // dropped rather than repaired into something that would execute.
          configs: Array.isArray(saved.configs) ? saved.configs.filter(isUsableConfig) : [],
        };
      },
    },
  ),
);

/** A stored configuration is only usable if it still passes every check. */
function isUsableConfig(value: unknown): value is RunConfiguration {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<RunConfiguration>;
  if (typeof config.id !== 'string' || typeof config.name !== 'string') return false;
  try {
    validateTaskName(config.name);
    validateCommand(String(config.command ?? ''));
    validateCwd(String(config.cwd ?? ''));
    validateEnvNames(Array.isArray(config.envNames) ? config.envNames : []);
    return true;
  } catch {
    return false;
  }
}

function patchRun(
  set: (updater: (state: TaskState) => Partial<TaskState>) => void,
  runId: string,
  patch: Partial<TaskRun>,
): void {
  set((state) => ({
    runs: state.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)),
  }));
}

/**
 * Run queued tasks one at a time until the queue empties.
 *
 * Re-entrant calls return immediately: the loop already running will pick up
 * whatever was just queued.
 */
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const state = useTaskStore.getState();
      const nextId = state.queue[0];
      if (!nextId) return;

      useTaskStore.setState({ queue: state.queue.slice(1), activeRunId: nextId });
      const run = useTaskStore.getState().runs.find((entry) => entry.id === nextId);
      if (!run || cancelled.has(nextId)) {
        useTaskStore.setState({ activeRunId: null });
        continue;
      }

      const config = useTaskStore.getState().configs.find((entry) => entry.id === run.configId);
      if (!config) {
        patchRun(useTaskStore.setState, nextId, {
          state: 'failed',
          output: ['This task no longer exists.'],
          endedAt: Date.now(),
        });
        useTaskStore.setState({ activeRunId: null });
        continue;
      }

      patchRun(useTaskStore.setState, nextId, { state: 'running', startedAt: Date.now() });

      // Mirror into the terminal, so a task run is visible where every other
      // command is, rather than only inside the tasks panel.
      const terminal = useTerminalStore.getState();
      const sessionId = terminal.activeId ?? terminal.createSession();
      terminal.append(sessionId, [{ kind: 'command', text: `task(${config.name})$ ${config.command}` }]);

      // The command is re-validated here, not only when it was saved: storage
      // could have been edited between the two.
      let output: string[] = [];
      let exitCode = 1;
      try {
        validateCommand(config.command);
        const session: ShellSession = { cwd: config.cwd, history: [] };
        const result = await execute(config.command, session, createShellHost());
        output = result.lines.map((line) => line.text);
        exitCode = result.exitCode;
        terminal.append(sessionId, result.lines);
      } catch (error) {
        output = [error instanceof Error ? error.message : String(error)];
        terminal.append(sessionId, [{ kind: 'stderr', text: output[0] }]);
      }

      if (cancelled.has(nextId)) {
        // Cancelled while it ran: the work happened, but the result is not
        // recorded as an outcome the user asked to keep.
        cancelled.delete(nextId);
        useTaskStore.setState({ activeRunId: null });
        continue;
      }

      patchRun(useTaskStore.setState, nextId, {
        state: exitCode === 0 ? 'succeeded' : 'failed',
        output: trimOutput(output),
        exitCode,
        endedAt: Date.now(),
      });
      useTaskStore.setState({ activeRunId: null });
    }
  } finally {
    draining = false;
  }
}
