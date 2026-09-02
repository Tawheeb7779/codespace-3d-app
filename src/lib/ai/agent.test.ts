// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MAX_STEPS, extractPlan, runAgent } from '@/lib/ai/agent';
import { TOOLS, ToolError, runTool, toolsFor, type ToolContext } from '@/lib/ai/tools';
import {
  PHASE_LABELS,
  isActive,
  isTerminal,
  newTask,
  phaseForTool,
  recordChange,
  summarise,
  transition,
  type FileChangeRecord,
} from '@/lib/ai/task';
import { WIDE_CHANGE_THRESHOLD, classify, isExternalCommand } from '@/lib/ai/approval';
import { ReadCache, detectStack, outlineOf, renderContext } from '@/lib/ai/context';
import type { ChatMessage, CompletionResult, ProviderConfig } from '@/lib/ai/provider';

/**
 * The agent, exercised through its real execution path.
 *
 * The model is scripted — there is no provider in a test run — but everything
 * below the model is the shipping code: real tool dispatch, real path
 * validation, real approval gating, real change tracking. A test that mocked
 * the tools would prove nothing about the agent.
 */

function workspace(files: Record<string, string>) {
  const state = { files: { ...files }, deleted: [] as string[], commands: [] as string[] };
  const changes: Array<{ path: string; kind: string }> = [];
  const ctx: ToolContext = {
    get files() {
      return state.files;
    },
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: (path, content) => {
      state.files[path] = content;
    },
    deletePath: (path) => {
      delete state.files[path];
      state.deleted.push(path);
    },
    runShell: async (command) => {
      state.commands.push(command);
      return `ran ${command}`;
    },
    terminalOutput: () => '',
    onChange: (path, kind) => changes.push({ path, kind }),
  };
  return { state, ctx, changes };
}

/** A provider that replays a fixed script of model turns. */
function scriptedProvider(turns: Array<Partial<CompletionResult>>) {
  let index = 0;
  return vi.fn(async (): Promise<CompletionResult> => {
    const turn = turns[Math.min(index, turns.length - 1)];
    index += 1;
    return {
      text: turn.text ?? '',
      toolCalls: turn.toolCalls ?? [],
      stopReason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
      raw: { role: 'assistant', content: turn.text ?? '' },
    };
  });
}

const CONFIG: ProviderConfig = { kind: 'openai', model: 'test', baseUrl: 'http://x/v1' };

async function drive(
  turns: Array<Partial<CompletionResult>>,
  ctx: ToolContext,
  options: { signal?: AbortSignal } = {},
) {
  const provider = scriptedProvider(turns);
  const module = await import('@/lib/ai/provider');
  const spy = vi.spyOn(module, 'complete').mockImplementation(provider as never);
  const activities: string[] = [];
  const phases: string[] = [];
  let plan: string[] = [];
  try {
    const result = await runAgent(
      CONFIG,
      'key',
      [{ role: 'user', content: 'do the thing' }] as ChatMessage[],
      ctx,
      {
        onActivity: (a) => activities.push(`${a.tool}:${a.state}`),
        onText: () => undefined,
        onToolStart: (tool) => phases.push(phaseForTool(tool)),
        onPlan: (p) => (plan = p),
      },
      options.signal ?? new AbortController().signal,
    );
    return { result, activities, phases, plan, calls: provider.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

describe('task lifecycle', () => {
  it('labels every phase it can be in', () => {
    for (const phase of Object.keys(PHASE_LABELS)) {
      expect(PHASE_LABELS[phase as keyof typeof PHASE_LABELS].length).toBeGreaterThan(2);
    }
  });

  it('derives the phase from the tool, not from what the model claims', () => {
    expect(phaseForTool('read_file')).toBe('reading');
    expect(phaseForTool('edit_file')).toBe('editing');
    expect(phaseForTool('run_command')).toBe('running');
    expect(phaseForTool('run_build')).toBe('verifying');
  });

  it('never reopens a finished task', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      const task = transition(newTask('x', 't1'), terminal);
      expect(isTerminal(task.phase)).toBe(true);
      // A late tool result must not put the panel back into "running".
      expect(transition(task, 'running').phase).toBe(terminal);
    }
  });

  it('reports activity only while genuinely working', () => {
    expect(isActive('planning')).toBe(true);
    expect(isActive('waiting_for_approval')).toBe(true);
    expect(isActive('idle')).toBe(false);
    expect(isActive('completed')).toBe(false);
  });
});

describe('the change ledger', () => {
  const fold = (entries: Array<Parameters<typeof recordChange>[1]>) =>
    entries.reduce<FileChangeRecord[]>((ledger, entry) => recordChange(ledger, entry), []);

  it('keeps the content from before the task, across repeated edits', () => {
    const ledger = fold([
      { path: 'a.ts', kind: 'modified', before: 'v0', after: 'v1' },
      { path: 'a.ts', kind: 'modified', before: 'v1', after: 'v2' },
    ]);
    // The diff the user reviews is the whole task, not the last tool call.
    expect(ledger).toEqual([
      { path: 'a.ts', kind: 'modified', before: 'v0', after: 'v2', touches: 2 },
    ]);
  });

  it('keeps a creation marked as created even after later edits', () => {
    const ledger = fold([
      { path: 'new.ts', kind: 'created', before: '', after: 'a' },
      { path: 'new.ts', kind: 'modified', before: 'a', after: 'b' },
    ]);
    expect(ledger[0]).toMatchObject({ kind: 'created', after: 'b' });
  });

  it('drops a file that was created and then deleted within the task', () => {
    const ledger = fold([
      { path: 'tmp.ts', kind: 'created', before: '', after: 'a' },
      { path: 'tmp.ts', kind: 'deleted', before: 'a', after: '' },
    ]);
    expect(ledger).toEqual([]);
  });

  it('summarises from the ledger, not from anything the model said', () => {
    const task = {
      ...newTask('x', 't'),
      changes: fold([
        { path: 'a.ts', kind: 'created', before: '', after: 'a' },
        { path: 'b.ts', kind: 'modified', before: 'x', after: 'y' },
      ]),
      commands: ['build'],
      verifications: [{ name: 'build', ok: true, ran: true, detail: 'ok' }],
    };
    expect(summarise(task)).toBe('1 created, 1 modified, 1 command(s) run, 1 checks passed');
    expect(summarise(newTask('x', 't'))).toBe('No changes were made.');
  });
});

describe('approval classification', () => {
  it('lets reads and ordinary edits run unattended', () => {
    for (const tool of ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file']) {
      expect(classify({ tool, input: { path: 'a.ts' }, changedSoFar: 0 }).decision, tool).toBe('auto');
    }
  });

  it('always asks before deleting', () => {
    const { decision, request } = classify({ tool: 'delete_file', input: { path: 'a.ts' }, changedSoFar: 0 });
    expect(decision).toBe('ask');
    expect(request?.severity).toBe('destructive');
    expect(request?.affects).toEqual(['a.ts']);
    expect(request?.what).toContain('a.ts');
  });

  it('asks before a destructive command and before one that acts outside the editor', () => {
    expect(classify({ tool: 'run_command', input: { command: 'rm -rf src' }, changedSoFar: 0 }))
      .toMatchObject({ decision: 'ask', request: { severity: 'destructive' } });
    expect(classify({ tool: 'run_command', input: { command: 'git commit -m x' }, changedSoFar: 0 }))
      .toMatchObject({ decision: 'ask', request: { severity: 'external' } });
    expect(classify({ tool: 'run_command', input: { command: 'npm install left-pad' }, changedSoFar: 0 }))
      .toMatchObject({ decision: 'ask', request: { severity: 'external' } });
  });

  it('does not ask for read-only subcommands of those tools', () => {
    for (const command of ['git status', 'git log', 'git diff', 'npm ls']) {
      expect(isExternalCommand(command), command).toBe(false);
      expect(classify({ tool: 'run_command', input: { command }, changedSoFar: 0 }).decision).toBe('auto');
    }
  });

  it('checks in once a task has edited a lot of files', () => {
    expect(classify({ tool: 'edit_file', input: { path: 'a.ts' }, changedSoFar: WIDE_CHANGE_THRESHOLD - 1 }).decision).toBe('auto');
    const wide = classify({ tool: 'edit_file', input: { path: 'a.ts' }, changedSoFar: WIDE_CHANGE_THRESHOLD });
    expect(wide.decision).toBe('ask');
    expect(wide.request?.severity).toBe('wide');
  });

  it('always says what will happen and to what', () => {
    for (const call of [
      { tool: 'delete_file', input: { path: 'a.ts' }, changedSoFar: 0 },
      { tool: 'run_command', input: { command: 'rm x' }, changedSoFar: 0 },
    ]) {
      const { request } = classify(call);
      expect(request?.what.length).toBeGreaterThan(5);
      expect(request?.why.length).toBeGreaterThan(5);
      expect(request?.affects.length).toBeGreaterThan(0);
    }
  });
});

describe('context efficiency', () => {
  it('detects the stack from the manifest rather than guessing', () => {
    expect(detectStack({ 'package.json': '{"dependencies":{"react":"18"}}' })).toMatchObject({
      framework: 'react',
      packageManager: 'npm',
    });
    expect(detectStack({}).framework).toBe('none');
    expect(detectStack({ 'package.json': 'not json' }).framework).toMatch(/not valid JSON/);
  });

  it('summarises the layout instead of listing every file', () => {
    const files: Record<string, string> = { 'package.json': '{}', 'index.html': '' };
    for (let i = 0; i < 500; i += 1) files[`src/components/c${i}.tsx`] = '';
    const outline = outlineOf(files);
    expect(outline.length).toBeLessThan(10);
    expect(outline).toContain('package.json');
    expect(outline).toContain('src/');
  });

  it('keeps the rendered header small even for a large project', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2000; i += 1) files[`src/f${i}.ts`] = 'x'.repeat(500);
    const header = renderContext({
      name: 'Big', template: 'react', language: 'TypeScript', framework: 'react',
      packageManager: 'npm', branch: 'main', dirty: [], diagnostics: [],
      fileCount: Object.keys(files).length, outline: outlineOf(files),
    });
    expect(header.length).toBeLessThan(1000);
    expect(header).toContain('Files: 2000');
  });

  it('does not resend a file the agent already read', () => {
    const cache = new ReadCache();
    const first = cache.record('a.ts', 'const a = 1;');
    const second = cache.record('a.ts', 'const a = 1;');
    expect(first.cached).toBe(false);
    expect(first.text).toBe('const a = 1;');
    expect(second.cached).toBe(true);
    expect(second.text).toMatch(/unchanged/);
  });

  it('resends it in full once the content changes', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'v1');
    const after = cache.record('a.ts', 'v2');
    expect(after.cached).toBe(false);
    expect(after.text).toBe('v2');
  });

  it('resends after the agent edits the file', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'v1');
    cache.invalidate('a.ts');
    expect(cache.record('a.ts', 'v1').cached).toBe(false);
  });
});

describe('plan extraction', () => {
  it('reads a numbered plan out of the model text', () => {
    expect(
      extractPlan('Here is the plan:\n1. Read the component\n2. Add the prop\n3. Build'),
    ).toEqual(['Read the component', 'Add the prop', 'Build']);
  });

  it('reads a bulleted plan too, and ignores prose', () => {
    expect(extractPlan('I will:\n- Look at App.tsx\n- Change the title\nThat is all.')).toEqual([
      'Look at App.tsx',
      'Change the title',
    ]);
  });

  it('finds nothing in a plain answer', () => {
    expect(extractPlan('The file already does that.')).toEqual([]);
  });
});

describe('the agent loop against real tools', () => {
  it('reads, edits and verifies, changing the real workspace', async () => {
    const { state, ctx, changes } = workspace({ 'src/app.ts': 'export const title = "old";\n' });
    let built = false;
    ctx.runBuild = async () => {
      built = true;
      return { ok: true, report: 'Build succeeded: src/app.ts in 12ms.' };
    };

    const { result, activities, phases, plan } = await drive(
      [
        {
          text: 'Plan:\n1. Read src/app.ts\n2. Change the title\n3. Build',
          toolCalls: [{ id: '1', name: 'read_file', input: { path: 'src/app.ts' } }],
        },
        {
          toolCalls: [
            {
              id: '2',
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: '"old"', new_string: '"new"' },
            },
          ],
        },
        { toolCalls: [{ id: '3', name: 'run_build', input: {} }] },
        { text: 'Changed the title and the build passes.' },
      ],
      ctx,
    );

    expect(state.files['src/app.ts']).toBe('export const title = "new";\n');
    expect(built).toBe(true);
    expect(changes).toEqual([{ path: 'src/app.ts', kind: 'modified' }]);
    expect(phases).toEqual(['reading', 'editing', 'verifying']);
    expect(plan).toEqual(['Read src/app.ts', 'Change the title', 'Build']);
    expect(activities).toContain('edit_file:done');
    expect(result.text).toMatch(/build passes/);
  });

  /** The recovery loop: a real failure, read back, fixed, re-verified. */
  it('reacts to a failing build, fixes the file and re-verifies', async () => {
    const { state, ctx } = workspace({ 'src/app.ts': 'export const a = ;\n' });
    let attempts = 0;
    ctx.runBuild = async () => {
      attempts += 1;
      const broken = state.files['src/app.ts'].includes('= ;');
      return broken
        ? { ok: false, report: 'Build failed with 1 error(s):\n  src/app.ts:1:17 Unexpected ";"' }
        : { ok: true, report: 'Build succeeded: src/app.ts in 9ms.' };
    };

    const { activities } = await drive(
      [
        { toolCalls: [{ id: '1', name: 'run_build', input: {} }] },
        { toolCalls: [{ id: '2', name: 'read_file', input: { path: 'src/app.ts' } }] },
        {
          toolCalls: [
            {
              id: '3',
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: '= ;', new_string: '= 1;' },
            },
          ],
        },
        { toolCalls: [{ id: '4', name: 'run_build', input: {} }] },
        { text: 'Fixed the syntax error; the build passes now.' },
      ],
      ctx,
    );

    expect(attempts).toBe(2);
    expect(state.files['src/app.ts']).toBe('export const a = 1;\n');
    // The first build genuinely failed and the agent saw it.
    expect(activities.filter((a) => a === 'run_build:done')).toHaveLength(2);
  });

  it('surfaces a tool failure to the model instead of hiding it', async () => {
    const { ctx } = workspace({ 'a.ts': 'x' });
    const { activities } = await drive(
      [
        { toolCalls: [{ id: '1', name: 'read_file', input: { path: 'missing.ts' } }] },
        { text: 'That file does not exist.' },
      ],
      ctx,
    );
    expect(activities).toContain('read_file:error');
  });

  it('stops rather than looping forever', async () => {
    const { ctx } = workspace({ 'a.ts': 'x' });
    await expect(
      drive([{ toolCalls: [{ id: 'n', name: 'list_files', input: {} }] }], ctx),
    ).rejects.toThrow(new RegExp(`${MAX_STEPS} steps`));
  });

  it('stops issuing tool calls once cancelled', async () => {
    const { state, ctx } = workspace({ 'a.ts': 'x' });
    const controller = new AbortController();
    ctx.runShell = async (command) => {
      state.commands.push(command);
      controller.abort(); // the user cancels while the first command runs
      return 'ok';
    };

    await expect(
      drive(
        [
          { toolCalls: [{ id: '1', name: 'run_command', input: { command: 'build' } }] },
          { toolCalls: [{ id: '2', name: 'run_command', input: { command: 'build again' } }] },
        ],
        ctx,
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/Abort/i);

    // The second command never ran: cancellation stopped the loop.
    expect(state.commands).toEqual(['build']);
  });
});

describe('interactive approval', () => {
  it('runs a destructive tool only after the user says yes', async () => {
    const { state, ctx } = workspace({ 'gone.ts': 'x' });
    const asked: Array<{ action: string; affects: string[] }> = [];
    ctx.requestApproval = async (action, affects) => {
      asked.push({ action, affects });
      return true;
    };

    await runTool('delete_file', { path: 'gone.ts' }, ctx);
    expect(asked).toEqual([{ action: 'Deleting gone.ts', affects: ['gone.ts'] }]);
    expect(state.deleted).toEqual(['gone.ts']);
  });

  it('leaves the file alone when the user declines', async () => {
    const { state, ctx } = workspace({ 'keep.ts': 'x' });
    ctx.requestApproval = async () => false;
    await expect(runTool('delete_file', { path: 'keep.ts' }, ctx)).rejects.toThrow(/declined/);
    expect(state.files['keep.ts']).toBe('x');
    expect(state.deleted).toEqual([]);
  });

  it('still refuses outright when no one can be asked', async () => {
    const { ctx } = workspace({ 'keep.ts': 'x' });
    // No requestApproval and no standing approval: the conservative default.
    await expect(runTool('delete_file', { path: 'keep.ts' }, ctx)).rejects.toThrow(ToolError);
  });

  it('does not ask again once the user has approved for the session', async () => {
    const { state, ctx } = workspace({ 'gone.ts': 'x' });
    let asked = 0;
    ctx.allowDestructive = true;
    ctx.requestApproval = async () => {
      asked += 1;
      return true;
    };
    await runTool('delete_file', { path: 'gone.ts' }, ctx);
    expect(asked).toBe(0);
    expect(state.deleted).toEqual(['gone.ts']);
  });

  it('gates a destructive command the same way', async () => {
    const { state, ctx } = workspace({ 'a.ts': 'x' });
    ctx.requestApproval = async () => false;
    await expect(runTool('run_command', { command: 'rm -rf src' }, ctx)).rejects.toThrow(/declined/);
    expect(state.commands).toEqual([]);
  });
});

describe('verification tools', () => {
  it('reports honestly when a build is unavailable rather than claiming success', async () => {
    const { ctx } = workspace({ 'a.ts': 'x' });
    expect(await runTool('run_build', {}, ctx)).toMatch(/not available/i);
    expect(await runTool('get_diagnostics', {}, ctx)).toMatch(/not available/i);
  });

  it('passes the real build report through untouched', async () => {
    const { ctx } = workspace({ 'a.ts': 'x' });
    ctx.runBuild = async () => ({ ok: false, report: 'Build failed with 2 error(s):\n  a.ts:1:1 bad' });
    expect(await runTool('run_build', {}, ctx)).toContain('Build failed with 2 error(s)');
  });

  it('offers the verification tools to a read-only caller too', () => {
    const names = toolsFor(false).map((t) => t.name);
    expect(names).toContain('run_build');
    expect(names).toContain('get_diagnostics');
    expect(names).not.toContain('write_file');
  });

  it('describes every tool it exposes', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});
