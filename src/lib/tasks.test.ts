// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  TaskError,
  commandHead,
  defaultConfigurations,
  durationOf,
  formatDuration,
  isFinished,
  validateCommand,
  validateCwd,
  validateEnvNames,
  validateTaskName,
  type TaskRun,
} from '@/lib/tasks';

/**
 * Run configurations are persisted data that decides what executes, which
 * makes them the most attacker-interesting thing this feature adds. The
 * validation is therefore an allowlist, and these tests are mostly about what
 * it must refuse — a saved task that smuggles a second command past the check
 * would be a shell escape wearing a friendly name.
 */

describe('command validation', () => {
  it('accepts the commands the project shell actually has', () => {
    for (const command of ['build', 'run', 'npm install left-pad', 'git status', 'ls src']) {
      expect(validateCommand(command), command).toBe(command);
    }
  });

  it('refuses a command that is not in the allowlist', () => {
    for (const command of ['curl http://evil.test', 'bash -c ls', 'sh', 'node index.js', 'sudo rm']) {
      expect(() => validateCommand(command), command).toThrow(TaskError);
    }
  });

  /** The shell has no chaining, so these are only ever an attempt to smuggle. */
  it('refuses chaining, redirection and substitution outright', () => {
    for (const command of [
      'build; curl evil.test',
      'build && rm -rf src',
      'build | sh',
      'build > /etc/passwd',
      'build `whoami`',
      'build $(whoami)',
      'build\nrm -rf src',
    ]) {
      expect(() => validateCommand(command), command).toThrow(/chaining|not a task command/i);
    }
  });

  it('refuses an empty or oversized command', () => {
    expect(() => validateCommand('   ')).toThrow(/needs a command/);
    expect(() => validateCommand(`build ${'x'.repeat(500)}`)).toThrow(/too long/);
  });

  it('reads the head case-insensitively, so casing cannot dodge the list', () => {
    expect(commandHead('  BUILD --watch ')).toBe('build');
    expect(() => validateCommand('CURL evil.test')).toThrow(TaskError);
  });
});

describe('working directory validation', () => {
  it('accepts a project-relative directory and normalises the edges', () => {
    expect(validateCwd('src/lib')).toBe('src/lib');
    expect(validateCwd('/src/')).toBe('src');
    expect(validateCwd('  ')).toBe('');
  });

  it('refuses anything that leaves the project or is protected', () => {
    for (const cwd of ['../etc', 'src/../../out', '.git', 'node_modules', '.ssh']) {
      expect(() => validateCwd(cwd), cwd).toThrow(TaskError);
    }
  });
});

describe('environment names', () => {
  /** The field a secret would most plausibly be typed into. */
  it('refuses anything that looks like a value rather than a name', () => {
    expect(() => validateEnvNames(['API_KEY=sk-secret'])).toThrow(/looks like a value/);
    expect(() => validateEnvNames(['TOKEN=abc'])).toThrow(/looks like a value/);
  });

  it('accepts real names, dedupes them and drops blanks', () => {
    expect(validateEnvNames(['API_URL', ' NODE_ENV ', '', 'API_URL'])).toEqual([
      'API_URL',
      'NODE_ENV',
    ]);
  });

  it('refuses names that are not valid identifiers', () => {
    for (const name of ['1BAD', 'has space', 'has-dash', 'has.dot']) {
      expect(() => validateEnvNames([name]), name).toThrow(TaskError);
    }
  });

  it('bounds how many are stored', () => {
    const many = Array.from({ length: 50 }, (_, i) => `VAR_${i}`);
    expect(validateEnvNames(many)).toHaveLength(20);
  });
});

describe('task names', () => {
  it('trims and collapses whitespace', () => {
    expect(validateTaskName('  Type   check ')).toBe('Type check');
  });

  it('refuses empty and overlong names', () => {
    expect(() => validateTaskName('  ')).toThrow(/needs a name/);
    expect(() => validateTaskName('x'.repeat(61))).toThrow(/60 characters/);
  });
});

describe('defaults', () => {
  it('ships only commands that pass validation', () => {
    for (const config of defaultConfigurations()) {
      expect(() => validateCommand(config.command), config.name).not.toThrow();
      expect(config.builtIn).toBe(true);
    }
  });

  it('marks exactly one default', () => {
    expect(defaultConfigurations().filter((config) => config.isDefault)).toHaveLength(1);
  });
});

describe('run state', () => {
  const run = (patch: Partial<TaskRun>): TaskRun => ({
    id: 'r',
    configId: 'c',
    name: 'Build',
    command: 'build',
    state: 'queued',
    output: [],
    exitCode: null,
    startedAt: null,
    endedAt: null,
    ...patch,
  });

  it('knows which states are settled', () => {
    expect(isFinished('queued')).toBe(false);
    expect(isFinished('running')).toBe(false);
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isFinished(state), state).toBe(true);
    }
  });

  it('reports no duration before a run starts', () => {
    expect(durationOf(run({}))).toBeNull();
  });

  it('measures a finished run, and a running one against now', () => {
    expect(durationOf(run({ startedAt: 1000, endedAt: 3500 }))).toBe(2500);
    expect(durationOf(run({ startedAt: 1000 }), 4000)).toBe(3000);
  });

  it('formats durations at every scale', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
});
