import { isSensitivePath } from '@/lib/vfs';

/**
 * Run configurations and the task model.
 *
 * A task is a *named* shell command, nothing more. It runs through the same
 * `execute` surface the terminal uses, so a task can do exactly what a user
 * could type and nothing else — there is no host shell here, and adding one
 * behind a friendlier name would be the obvious way to lose that property.
 *
 * The interesting constraint is the environment. Real run configurations carry
 * environment variables, and people put secrets in them. This model stores
 * variable *names* only: a configuration says "this run needs API_KEY", and the
 * value is looked up at run time from the project, never written into the
 * configuration and never persisted alongside it.
 */

export type TaskKind = 'build' | 'run' | 'test' | 'lint' | 'custom';

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunConfiguration {
  id: string;
  name: string;
  kind: TaskKind;
  /** The command line, run through the project shell. */
  command: string;
  /** Project-relative working directory; empty means the project root. */
  cwd: string;
  /**
   * Names of environment variables this run expects — never their values.
   * Present so a configuration can document what it needs without holding it.
   */
  envNames: string[];
  /** The configuration used when nothing else is chosen. */
  isDefault: boolean;
  /** Built-in configurations cannot be deleted, only edited. */
  builtIn: boolean;
}

export interface TaskRun {
  id: string;
  configId: string;
  name: string;
  command: string;
  state: TaskState;
  /** Output lines, capped so a runaway task cannot exhaust memory. */
  output: string[];
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** Output lines kept per run. */
export const MAX_TASK_OUTPUT = 2000;

/**
 * Commands a task may start.
 *
 * An allowlist rather than a denylist: a configuration is persisted data, and
 * persisted data that decides what runs is exactly the thing an attacker would
 * try to write. Anything not named here is refused when the task is saved and
 * again before it runs.
 */
const ALLOWED_COMMANDS = new Set([
  'build',
  'run',
  'stop',
  'npm',
  'git',
  'ls',
  'tree',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'wc',
  'stat',
  'echo',
  'pwd',
  'env',
  'date',
  'whoami',
  'history',
  'help',
]);

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * Check a command before it is stored or run.
 *
 * Shell metacharacters are refused outright rather than escaped: the project
 * shell does not implement pipes, redirection or command chaining, so a
 * configuration containing them is either a mistake or an attempt to smuggle a
 * second command past the allowlist. Neither should be saved.
 */
export function validateCommand(command: string): string {
  const clean = command.trim();
  if (!clean) throw new TaskError('A task needs a command.');
  if (clean.length > 400) throw new TaskError('That command is too long.');
  if (/[;&|`$><\n\r]/.test(clean)) {
    throw new TaskError(
      'Command chaining and redirection are not supported. Use a single command.',
    );
  }
  const head = commandHead(clean);
  if (!ALLOWED_COMMANDS.has(head)) {
    throw new TaskError(
      `"${head}" is not a task command. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}.`,
    );
  }
  return clean;
}

/** A task's working directory is a project path, subject to the same policy. */
export function validateCwd(cwd: string): string {
  const clean = cwd.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  if (clean.includes('..')) throw new TaskError('The working directory cannot leave the project.');
  if (isSensitivePath(clean)) throw new TaskError(`"${clean}" is a protected path.`);
  return clean;
}

export function validateTaskName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new TaskError('A task needs a name.');
  if (clean.length > 60) throw new TaskError('Task names must be 60 characters or fewer.');
  return clean;
}

/**
 * Environment *names* only.
 *
 * Rejecting anything with an `=` is what keeps a value from being typed into
 * the name field and quietly persisted — the single most likely way a secret
 * would end up in a stored configuration.
 */
export function validateEnvNames(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const clean = raw.trim();
    if (!clean) continue;
    if (clean.includes('=')) {
      throw new TaskError(
        `"${clean}" looks like a value. List only the variable name; values are never stored here.`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) {
      throw new TaskError(`"${clean}" is not a valid environment variable name.`);
    }
    if (!out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 20);
}

/** The configurations every project starts with, matching the shell it has. */
export function defaultConfigurations(): Omit<RunConfiguration, 'id'>[] {
  return [
    {
      name: 'Build',
      kind: 'build',
      command: 'build',
      cwd: '',
      envNames: [],
      isDefault: false,
      builtIn: true,
    },
    {
      name: 'Run preview',
      kind: 'run',
      command: 'run',
      cwd: '',
      envNames: [],
      isDefault: true,
      builtIn: true,
    },
  ];
}

export const STATE_LABELS: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function isFinished(state: TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/** Elapsed milliseconds, or null while a task has not started. */
export function durationOf(run: TaskRun, now = Date.now()): number | null {
  if (run.startedAt === null) return null;
  return (run.endedAt ?? now) - run.startedAt;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
