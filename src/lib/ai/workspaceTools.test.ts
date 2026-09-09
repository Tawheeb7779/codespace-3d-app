import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOLS, toolsFor, type ToolContext } from '@/lib/ai/tools';
import {
  pendingRequestCount,
  registerProjectWorkspace,
  resolveWorkspaceRequest,
  subscribeWorkspace,
  workspaceCheck,
  workspaceConnected,
  workspaceGit,
} from '@/lib/ai/workspaceBridge';

/**
 * The agent's reach into the real workspace, and the honesty of its answers.
 *
 * Two properties matter more than any feature here. The first is that the agent
 * cannot run a command it chose: it names a check, and the gateway holds the
 * allowlist. The second is that when there is no workspace, the agent is *told*
 * — because an agent that quietly substitutes the in-browser bundler for
 * `npm test` is an agent reporting a verification it did not perform, which is
 * worse than one that cannot verify at all.
 */

const tool = (name: string) => {
  const found = TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

/** A context with no container attached, which is the default deployment. */
function contextWithoutWorkspace(): ToolContext {
  return {
    files: { 'app.ts': 'export const x = 1;\n' },
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: () => undefined,
    deletePath: () => undefined,
    runShell: async () => '',
    terminalOutput: () => '',
  };
}

function contextWithWorkspace(overrides: Partial<NonNullable<ToolContext['workspace']>> = {}) {
  const context = contextWithoutWorkspace();
  context.workspace = {
    connected: () => true,
    listChecks: async () => ({ ok: true, available: ['test', 'lint'] }),
    runCheck: async (script: string) => ({
      ok: true,
      result: { script, ok: true, exitCode: 0, output: 'ok\n', truncated: false },
    }),
    gitStatus: async () => ({ ok: true, data: { repository: true, branch: 'main', dirty: false } }),
    gitDiff: async () => ({ ok: true, data: '' }),
    ...overrides,
  };
  return context;
}

afterEach(() => {
  registerProjectWorkspace(null);
});

describe('an agent with no container workspace', () => {
  /**
   * The whole point. Every one of these could have quietly fallen back to the
   * in-browser equivalent and reported success.
   */
  it.each([
    'list_project_checks',
    'run_project_check',
    'get_git_status',
    'get_workspace_diff',
  ])('tells the truth from %s rather than substituting something else', async (name) => {
    const answer = await tool(name).run({ script: 'test' }, contextWithoutWorkspace());

    expect(String(answer)).toMatch(/no container workspace/i);
    expect(String(answer)).not.toMatch(/passed|succeeded|clean/i);
  });

  it('reports a disconnected bridge rather than hanging', async () => {
    registerProjectWorkspace(null);

    expect(workspaceConnected()).toBe(false);
    await expect(workspaceGit({ op: 'status' })).resolves.toMatchObject({ ok: false });
    await expect(workspaceCheck({ op: 'list' })).resolves.toMatchObject({ ok: false });
  });
});

describe('an agent with a workspace', () => {
  it('lists only the checks the project defines', async () => {
    const answer = await tool('list_project_checks').run({}, contextWithWorkspace());

    expect(answer).toContain('test');
    expect(answer).toContain('lint');
  });

  it('says so plainly when a project defines no checks', async () => {
    const answer = await tool('list_project_checks').run(
      {},
      contextWithWorkspace({ listChecks: async () => ({ ok: true, available: [] }) }),
    );

    expect(String(answer)).toMatch(/defines none/i);
  });

  it('reports a passing check with its exit code', async () => {
    const answer = await tool('run_project_check').run({ script: 'test' }, contextWithWorkspace());

    expect(String(answer)).toMatch(/test passed \(exit 0\)/);
  });

  /**
   * A failure must read as a failure. An agent that summarises a failing suite
   * as "ran the tests" is the specific dishonesty this asserts against.
   */
  it('reports a failing check as FAILED, with the real output', async () => {
    const answer = await tool('run_project_check').run(
      { script: 'test' },
      contextWithWorkspace({
        runCheck: async (script: string) => ({
          ok: true,
          result: {
            script,
            ok: false,
            exitCode: 1,
            output: 'FAIL src/app.test.ts\n  expected 2 to be 3\n',
            truncated: false,
          },
        }),
      }),
    );

    expect(String(answer)).toMatch(/FAILED \(exit 1\)/);
    expect(String(answer)).toContain('expected 2 to be 3');
  });

  it('passes a refusal through instead of turning it into a success', async () => {
    const answer = await tool('run_project_check').run(
      { script: 'deploy' },
      contextWithWorkspace({
        runCheck: async () => ({ ok: false, message: '"deploy" is not a check this workspace will run.' }),
      }),
    );

    expect(String(answer)).toMatch(/not a check/i);
  });

  it('reads real git status, including a clean tree', async () => {
    const answer = await tool('get_git_status').run({}, contextWithWorkspace());

    expect(String(answer)).toMatch(/On branch main .* clean/);
  });

  it('names the changed files when the tree is dirty', async () => {
    const answer = await tool('get_git_status').run(
      {},
      contextWithWorkspace({
        gitStatus: async () => ({
          ok: true,
          data: {
            repository: true,
            branch: 'feature',
            dirty: true,
            files: [{ path: 'src/app.ts', code: '.M', staged: false, untracked: false }],
          },
        }),
      }),
    );

    expect(String(answer)).toContain('src/app.ts');
    expect(String(answer)).toContain('feature');
  });

  it('says a workspace has no repository rather than reporting it clean', async () => {
    const answer = await tool('get_git_status').run(
      {},
      contextWithWorkspace({
        gitStatus: async () => ({ ok: true, data: { repository: false } }),
      }),
    );

    expect(String(answer)).toMatch(/no git repository/i);
  });
});

describe('what the agent is not given', () => {
  /**
   * No tool takes a command line for the container. `run_command` exists and
   * runs in the *in-browser* shell, which has no host, no network and no
   * process — that is a different thing from a shell in the container, and the
   * distinction is the reason the agent has no container shell at all.
   */
  it('has no tool that runs an arbitrary command in the container', () => {
    const containerTools = TOOLS.filter((entry) => /project_check|git_status|workspace_diff/.test(entry.name));

    for (const entry of containerTools) {
      const properties = Object.keys(entry.input_schema.properties);
      expect(properties).not.toContain('command');
      expect(properties).not.toContain('args');
      expect(properties).not.toContain('argv');
      expect(properties).not.toContain('shell');
    }
  });

  it('offers no container tool that writes, pushes or deletes', () => {
    const names = TOOLS.map((entry) => entry.name);

    for (const forbidden of [
      'git_commit',
      'git_push',
      'git_checkout',
      'git_reset',
      'container_shell',
      'run_in_container',
      'linux_workspace_run',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  /**
   * A viewer gets the read-only set. These four are all reads, so they survive
   * the filter — and none of them can change anything, which is why that is
   * correct rather than an oversight.
   */
  it('keeps the workspace tools available to a read-only caller, because they only read', () => {
    const readOnly = toolsFor(false).map((entry) => entry.name);

    expect(readOnly).toContain('get_git_status');
    expect(readOnly).toContain('run_project_check');
    expect(readOnly).not.toContain('write_file');
    expect(readOnly).not.toContain('delete_file');
  });
});

describe('the request bridge', () => {
  it('routes an answer to the request that asked for it', async () => {
    const client = {
      containerId: 'tacode-x',
      git: vi.fn(() => 'git-1'),
      check: vi.fn(() => 'check-1'),
    };
    registerProjectWorkspace(client as never);

    const gitAnswer = workspaceGit({ op: 'status' });
    const checkAnswer = workspaceCheck({ op: 'list' });
    expect(pendingRequestCount()).toBe(2);

    // Answered out of order, which is the ordinary case.
    resolveWorkspaceRequest('check-1', { ok: true, available: ['test'] });
    resolveWorkspaceRequest('git-1', { ok: true, data: { repository: true } });

    await expect(checkAnswer).resolves.toMatchObject({ available: ['test'] });
    await expect(gitAnswer).resolves.toMatchObject({ data: { repository: true } });
    expect(pendingRequestCount()).toBe(0);
  });

  /**
   * A panel that closes mid-request must not strand the turn. The entry is
   * rejected rather than left waiting for an answer nobody will send.
   */
  it('rejects everything in flight when the workspace disconnects', async () => {
    const client = { containerId: 'tacode-x', git: () => 'git-2', check: () => 'check-2' };
    registerProjectWorkspace(client as never);

    const answer = workspaceGit({ op: 'status' });
    registerProjectWorkspace(null);

    await expect(answer).rejects.toThrow(/disconnected/i);
    expect(pendingRequestCount()).toBe(0);
  });

  it('ignores an answer to a request nobody is waiting for', () => {
    expect(() => resolveWorkspaceRequest('never-asked', { ok: true })).not.toThrow();
  });

  /**
   * A reconnect can hand back the same client object attached to a *different*
   * container — a rebuilt workspace is a different repository. A watcher told
   * nothing would keep rendering the previous container's state, so the
   * container id is part of what counts as a change.
   */
  it('tells watchers when the same client picks up a different container', () => {
    const client = { containerId: 'tacode-one', git: () => null, check: () => null };
    const seen: string[] = [];
    const stop = subscribeWorkspace(() => seen.push(client.containerId));

    registerProjectWorkspace(client as never);
    client.containerId = 'tacode-two';
    registerProjectWorkspace(client as never);

    stop();
    expect(seen).toEqual(['tacode-one', 'tacode-two']);
  });

  it('does not wake watchers when nothing changed', () => {
    const client = { containerId: 'tacode-one', git: () => null, check: () => null };
    registerProjectWorkspace(client as never);
    let woken = 0;
    const stop = subscribeWorkspace(() => (woken += 1));

    registerProjectWorkspace(client as never);

    stop();
    expect(woken).toBe(0);
  });
});
