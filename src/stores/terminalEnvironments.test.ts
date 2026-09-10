import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore, ENVIRONMENT_LABEL } from '@/stores/terminalStore';
import { TOOLS, type ToolContext } from '@/lib/ai/tools';

/**
 * Two terminals, not one terminal with a selector.
 *
 * The environment used to be a single setting on the panel. Choosing "Linux"
 * therefore took the project terminal off the screen: they were two views of
 * one terminal, and a person could not have `npm test` running in the project
 * *while* working in a Linux shell. Moving the environment onto the session is
 * what makes them genuinely two terminals — separate processes, working
 * directories, histories, scrollback and lifecycles, both open at once.
 *
 * The agent is bound by the same distinction, and more strictly: `run_command`
 * is the in-browser project shell and cannot reach a container at all, so a
 * command it means for Linux must not be quietly executed somewhere else.
 */

const store = () => useTerminalStore.getState();

beforeEach(() => {
  useTerminalStore.setState({ sessions: [], activeId: null });
});

describe('two terminals open at once', () => {
  it('keeps both alive rather than replacing one with the other', () => {
    const project = store().createSession('project');
    const linux = store().createSession('linux');

    const ids = store().sessions.map((session) => session.id);
    expect(ids).toContain(project);
    expect(ids).toContain(linux);
    expect(store().sessions).toHaveLength(2);
  });

  it('gives every session its own environment, fixed for its life', () => {
    store().createSession('project');
    store().createSession('project-container');
    store().createSession('linux');

    expect(store().sessions.map((session) => session.environment)).toEqual([
      'project',
      'project-container',
      'linux',
    ]);
  });

  /** Independent lifecycle: closing one must not disturb the other. */
  it('closing one terminal leaves the other running', () => {
    const project = store().createSession('project');
    const linux = store().createSession('linux');

    store().killSession(linux);

    expect(store().sessions.map((session) => session.id)).toEqual([project]);
    expect(store().sessions[0].environment).toBe('project');
  });

  /** Independent state: output written to one must never appear in the other. */
  it('keeps output streams separate', () => {
    const project = store().createSession('project');
    const linux = store().createSession('linux');

    store().append(project, [{ kind: 'stdout', text: 'project output' }]);
    store().append(linux, [{ kind: 'stdout', text: 'linux output' }]);

    expect(store().transcript(project)).toContain('project output');
    expect(store().transcript(project)).not.toContain('linux output');
    expect(store().transcript(linux)).toContain('linux output');
    expect(store().transcript(linux)).not.toContain('project output');
  });

  it('names sessions after their environment, not "terminal 1" and "terminal 2"', () => {
    store().createSession('project');
    store().createSession('linux');
    store().createSession('linux');

    const names = store().sessions.map((session) => session.name);
    expect(names[0]).toBe('project');
    expect(names[1]).toBe('linux');
    // Numbered within its own environment, so a second Linux terminal is not
    // "terminal 3" just because two project terminals exist.
    expect(names[2]).toBe('linux 2');
  });

  it('has a distinct human label for each environment', () => {
    expect(new Set(Object.values(ENVIRONMENT_LABEL)).size).toBe(3);
    expect(ENVIRONMENT_LABEL.project).toMatch(/project/i);
    expect(ENVIRONMENT_LABEL.linux).toMatch(/linux/i);
  });
});

describe('which session a caller gets', () => {
  /**
   * The agent's shell and the task runner mean the in-browser project shell.
   * Handing them whichever tab is focused would write their output into a
   * container session, whose screen comes from a PTY and would never show it.
   */
  it('never hands the project shell a container session because it was focused', () => {
    const project = store().createSession('project');
    const linux = store().createSession('linux');
    store().setActive(linux);

    expect(store().ensureSession('project')).toBe(project);
  });

  it('creates one when the asked-for environment has none', () => {
    store().createSession('linux');

    const id = store().ensureSession('project');

    expect(store().sessions.find((session) => session.id === id)?.environment).toBe('project');
  });

  it('prefers the focused session when it is already the right environment', () => {
    store().createSession('project');
    const second = store().createSession('project');
    store().setActive(second);

    expect(store().ensureSession('project')).toBe(second);
  });
});

describe('running a command', () => {
  it('runs in the in-browser project shell', async () => {
    const id = store().createSession('project');

    await store().run(id, 'echo hello');

    expect(store().transcript(id)).toContain('echo hello');
  });

  /**
   * A container session's input is bytes to a PTY. Executing it in the
   * browser's interpreter instead would print a plausible answer that no
   * machine produced — the exact dishonesty the architecture forbids.
   */
  it.each(['project-container', 'linux'] as const)(
    'refuses to execute a command in a %s session rather than simulating one',
    async (environment) => {
      const id = store().createSession(environment);

      await store().run(id, 'rm -rf /');

      expect(store().transcript(id)).toBe('');
      expect(store().sessions.find((session) => session.id === id)?.busy).toBe(false);
    },
  );
});

describe('what the agent is told and what it may read', () => {
  const tool = (name: string) => {
    const found = TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  function context(byEnvironment: Record<string, string>): ToolContext {
    return {
      files: {},
      dirs: [],
      canWrite: true,
      allowDestructive: false,
      writeFile: () => undefined,
      deletePath: () => undefined,
      runShell: async () => '',
      terminalOutput: (environment = 'project') => byEnvironment[environment] ?? '',
    };
  }

  it('reads the environment the agent named, not whichever was focused', async () => {
    const ctx = context({ project: 'project lines', linux: 'linux lines' });

    expect(await tool('get_terminal_output').run({ environment: 'linux' }, ctx)).toContain(
      'linux lines',
    );
    expect(await tool('get_terminal_output').run({ environment: 'project' }, ctx)).toContain(
      'project lines',
    );
  });

  it('defaults to the project terminal', async () => {
    const ctx = context({ project: 'project lines', linux: 'linux lines' });

    const answer = await tool('get_terminal_output').run({}, ctx);

    expect(String(answer)).toContain('project lines');
  });

  /** A wrong machine's output answering a specific question is worse than none. */
  it('refuses an environment it does not recognise', async () => {
    const ctx = context({ project: 'project lines' });

    expect(() => tool('get_terminal_output').run({ environment: 'host' }, ctx)).toThrow(
      /unknown terminal environment/i,
    );
  });

  it('names the empty environment rather than implying the project is quiet', async () => {
    const ctx = context({ project: 'project lines' });

    const answer = await tool('get_terminal_output').run({ environment: 'linux' }, ctx);

    expect(String(answer)).toContain(ENVIRONMENT_LABEL.linux);
    expect(String(answer)).not.toContain('project lines');
  });

  /**
   * The description is the only thing standing between the model and writing
   * Linux commands for a shell that has no Linux.
   */
  it('tells the agent plainly that run_command is not a container shell', () => {
    const description = tool('run_command').description;

    expect(description).toMatch(/project terminal/i);
    expect(description).toMatch(/not the linux terminal/i);
    expect(description).toMatch(/run_project_check/);
  });

  it('offers the agent no way to type into a container terminal', () => {
    const names = TOOLS.map((entry) => entry.name);

    for (const forbidden of ['linux_terminal_run', 'container_exec', 'terminal_write']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
