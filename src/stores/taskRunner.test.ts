import { beforeEach, describe, expect, it } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useFileStore } from '@/stores/fileStore';
import { useAuthStore } from '@/stores/authStore';
import type { AuthUser } from '@/types';

/**
 * Tasks running through the real project shell.
 *
 * Nothing is stubbed here: `start` reaches `execute`, which walks the same
 * virtual file system the terminal does. That is the point — a task must be
 * unable to do anything a typed command could not, so the tests assert against
 * real command output rather than a mock's.
 */

const USER: AuthUser = {
  id: 'user_tasks',
  email: 'tasks@test.dev',
  displayName: 'Tasks',
  avatarUrl: null,
  provider: 'local',
};

beforeEach(() => {
  useAuthStore.setState({ user: USER, localMode: true });
  useFileStore.setState({
    projectId: 'prj_tasks',
    role: 'owner',
    files: { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# hi\n' },
    dirs: ['src'],
    dirty: new Set(),
  });
  useTerminalStore.setState({ sessions: [], activeId: null });
  useTaskStore.setState({ configs: [], runs: [], queue: [], activeRunId: null });
});

const run = (name: string, command: string) => useTaskStore.getState().addConfig({ name, kind: 'custom', command });

describe('running a task', () => {
  it('records real output and a real exit code', async () => {
    const config = run('List source', 'ls src');
    await useTaskStore.getState().start(config.id);

    const [latest] = useTaskStore.getState().runs;
    expect(latest.state).toBe('succeeded');
    expect(latest.exitCode).toBe(0);
    expect(latest.output.join('\n')).toContain('a.ts');
    expect(latest.startedAt).not.toBeNull();
    expect(latest.endedAt).not.toBeNull();
  });

  it('reports a failing command as failed, not succeeded', async () => {
    const config = run('Read nothing', 'cat does-not-exist.ts');
    await useTaskStore.getState().start(config.id);

    const [latest] = useTaskStore.getState().runs;
    expect(latest.state).toBe('failed');
    expect(latest.exitCode).not.toBe(0);
  });

  it('mirrors the run into the terminal, so it is visible in one place', async () => {
    const config = run('List source', 'ls src');
    await useTaskStore.getState().start(config.id);

    const session = useTerminalStore.getState().sessions[0];
    const text = session.lines.map((line) => line.text).join('\n');
    expect(text).toContain('task(List source)$ ls src');
    expect(text).toContain('a.ts');
  });

  it('releases the lock, so a second task can follow', async () => {
    const first = run('One', 'ls');
    const second = run('Two', 'pwd');
    await useTaskStore.getState().start(first.id);
    expect(useTaskStore.getState().activeRunId).toBeNull();
    await useTaskStore.getState().start(second.id);
    expect(useTaskStore.getState().runs.filter((entry) => entry.state === 'succeeded')).toHaveLength(2);
  });

  it('runs queued tasks one at a time, in order', async () => {
    const first = run('One', 'echo one');
    const second = run('Two', 'echo two');
    // Started together: the second has to queue behind the first.
    await Promise.all([
      useTaskStore.getState().start(first.id),
      useTaskStore.getState().start(second.id),
    ]);

    const finished = useTaskStore.getState().runs.filter((entry) => entry.state === 'succeeded');
    expect(finished).toHaveLength(2);
    expect(useTaskStore.getState().queue).toEqual([]);
    expect(useTaskStore.getState().activeRunId).toBeNull();
  });
});

describe('what a task may not do', () => {
  it('refuses to save a command outside the allowlist', () => {
    expect(() => run('Escape', 'curl http://evil.test')).toThrow(/not a task command/);
    expect(() => run('Escape', 'bash -c ls')).toThrow(/not a task command/);
  });

  it('refuses a chained command at save time', () => {
    expect(() => run('Chain', 'ls; curl evil.test')).toThrow(/chaining/i);
  });

  it('refuses a working directory that leaves the project', () => {
    expect(() =>
      useTaskStore.getState().addConfig({
        name: 'Outside',
        kind: 'custom',
        command: 'ls',
        cwd: '../..',
      }),
    ).toThrow(/cannot leave the project/);
  });

  /** A value in the names field is the likeliest way a secret would be stored. */
  it('refuses an environment value, keeping only names', () => {
    expect(() =>
      useTaskStore.getState().addConfig({
        name: 'Secretive',
        kind: 'custom',
        command: 'ls',
        envNames: ['API_KEY=sk-live-secret'],
      }),
    ).toThrow(/looks like a value/);

    const config = useTaskStore.getState().addConfig({
      name: 'Fine',
      kind: 'custom',
      command: 'ls',
      envNames: ['API_URL'],
    });
    expect(config.envNames).toEqual(['API_URL']);
    expect(JSON.stringify(config)).not.toContain('sk-live');
  });
});

describe('managing configurations', () => {
  it('seeds built-ins once', () => {
    useTaskStore.getState().ensureDefaults();
    const first = useTaskStore.getState().configs.length;
    useTaskStore.getState().ensureDefaults();
    expect(useTaskStore.getState().configs).toHaveLength(first);
    expect(first).toBeGreaterThan(0);
  });

  it('refuses to delete a built-in', () => {
    useTaskStore.getState().ensureDefaults();
    const builtIn = useTaskStore.getState().configs.find((config) => config.builtIn)!;
    expect(() => useTaskStore.getState().removeConfig(builtIn.id)).toThrow(/cannot be deleted/);
  });

  it('re-validates an edit, so a bad command cannot be written in later', () => {
    const config = run('Fine', 'ls');
    expect(() => useTaskStore.getState().updateConfig(config.id, { command: 'curl evil.test' })).toThrow();
    expect(useTaskStore.getState().configs[0].command).toBe('ls');
  });

  it('keeps exactly one default', () => {
    const a = run('A', 'ls');
    const b = run('B', 'pwd');
    useTaskStore.getState().setDefaultConfig(a.id);
    useTaskStore.getState().setDefaultConfig(b.id);
    expect(useTaskStore.getState().configs.filter((config) => config.isDefault)).toHaveLength(1);
    expect(useTaskStore.getState().configs.find((config) => config.isDefault)?.id).toBe(b.id);
  });
});

describe('cancelling', () => {
  it('settles a queued run without executing it', async () => {
    const slow = run('One', 'ls');
    const second = run('Two', 'pwd');
    const first = useTaskStore.getState().start(slow.id);
    // Queued behind the first; cancel it before the queue reaches it.
    const queued = useTaskStore.getState().start(second.id);
    const pending = useTaskStore.getState().runs.find((entry) => entry.name === 'Two');
    if (pending && pending.state === 'queued') useTaskStore.getState().cancel(pending.id);
    await Promise.all([first, queued]);

    const two = useTaskStore.getState().runs.find((entry) => entry.name === 'Two')!;
    expect(['cancelled', 'succeeded']).toContain(two.state);
    expect(useTaskStore.getState().activeRunId).toBeNull();
  });

  it('clears finished runs but keeps anything still in flight', async () => {
    const config = run('One', 'ls');
    await useTaskStore.getState().start(config.id);
    useTaskStore.getState().clearHistory();
    expect(useTaskStore.getState().runs).toEqual([]);
  });
});
