import { describe, expect, it } from 'vitest';
import { TOOLS, runTool, toolsFor, type ToolContext } from '@/lib/ai/tools';
import type { ChangePlan } from '@/lib/ai/plan';

/**
 * The three tools that let the agent understand a project before changing it.
 *
 * Two properties are checked here that the pure modules cannot check alone.
 *
 * `plan_changes` must be side-effect free *through the tool layer too* — it
 * takes a context carrying `writeFile` and `deletePath`, and it must call
 * neither. A planning tool that wrote would make the review step theatre.
 *
 * And all three must remain available to a read-only user. Someone who cannot
 * edit a project can still ask what is in it; gating comprehension behind write
 * permission would make the assistant useless to a reviewer.
 */

interface Spy {
  writes: string[];
  deletes: string[];
  plans: ChangePlan[];
}

function context(files: Record<string, string>, overrides: Partial<ToolContext> = {}): {
  ctx: ToolContext;
  spy: Spy;
} {
  const spy: Spy = { writes: [], deletes: [], plans: [] };
  const ctx: ToolContext = {
    files,
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: (path) => spy.writes.push(path),
    deletePath: (path) => spy.deletes.push(path),
    runShell: async () => '',
    terminalOutput: () => '',
    onPlan: (plan) => spy.plans.push(plan),
    ...overrides,
  };
  return { ctx, spy };
}

const PROJECT = {
  'package.json': '{"dependencies":{"react":"18.0.0"}}',
  'src/main.tsx': "import { App } from './App';\nimport React from 'react';\n",
  'src/App.tsx': "import { helper } from '@/lib/helper';\nexport function App() { return null; }\n",
  'src/lib/helper.ts': 'export const helper = 1;\n',
};

describe('get_project_intelligence', () => {
  it('describes the project’s real structure', async () => {
    const { ctx } = context(PROJECT);
    const answer = await runTool('get_project_intelligence', {}, ctx);

    expect(answer).toContain('src/main.tsx');
    expect(answer).toContain('react');
  });

  it('accepts a focus and analyses it', async () => {
    const { ctx } = context(PROJECT);
    const answer = await runTool('get_project_intelligence', { focus: 'src/lib/helper.ts' }, ctx);

    expect(answer).toContain('src/lib/helper.ts');
  });

  /** A focus naming a blocked path must not smuggle it into the analysis. */
  it('ignores a sensitive path in the focus', async () => {
    const { ctx } = context({ ...PROJECT, '.env': 'SECRET=1' });
    const answer = await runTool('get_project_intelligence', { focus: '.env' }, ctx);

    expect(answer).not.toContain('SECRET');
  });

  it('does not throw on a malformed focus', async () => {
    const { ctx } = context(PROJECT);

    await expect(
      runTool('get_project_intelligence', { focus: '/etc/passwd, ../../x, ' }, ctx),
    ).resolves.toBeTypeOf('string');
  });

  it('works on an empty project', async () => {
    const { ctx } = context({});

    await expect(runTool('get_project_intelligence', {}, ctx)).resolves.toContain('0 files');
  });
});

describe('find_related_code', () => {
  it('reports both directions of the relationship', async () => {
    const { ctx } = context(PROJECT);
    const answer = await runTool('find_related_code', { path: 'src/App.tsx' }, ctx);

    expect(answer).toContain('src/lib/helper.ts');
    expect(answer).toContain('src/main.tsx');
  });

  it('refuses a file that is not in the project', async () => {
    const { ctx } = context(PROJECT);

    await expect(runTool('find_related_code', { path: 'src/Gone.tsx' }, ctx)).rejects.toThrow(
      /No such file/,
    );
  });

  it('refuses an absolute path', async () => {
    const { ctx } = context(PROJECT);

    await expect(runTool('find_related_code', { path: '/etc/passwd' }, ctx)).rejects.toThrow(
      /absolute path/i,
    );
  });

  /**
   * "Nothing imports this" is a claim worth qualifying: a dynamic import, or a
   * path this cannot resolve, looks identical to genuinely unused.
   */
  it('qualifies an empty result rather than asserting the file is unused', async () => {
    const { ctx } = context(PROJECT);
    const answer = await runTool('find_related_code', { path: 'src/main.tsx' }, ctx);

    expect(answer).toMatch(/would also look like this/i);
  });
});

describe('plan_changes', () => {
  const plan = {
    goal: 'Add a settings page',
    changes: [{ path: 'src/Settings.tsx', operation: 'create', reason: 'the new page' }],
    steps: ['run the build'],
  };

  it('echoes the plan back', async () => {
    const { ctx } = context(PROJECT);
    const answer = await runTool('plan_changes', plan, ctx);

    expect(answer).toContain('src/Settings.tsx');
    expect(answer).toContain('Add a settings page');
  });

  /** The property the review step depends on, checked through the tool layer. */
  it('writes nothing and deletes nothing', async () => {
    const { ctx, spy } = context(PROJECT);
    await runTool('plan_changes', plan, ctx);

    expect(spy.writes).toEqual([]);
    expect(spy.deletes).toEqual([]);
    expect(Object.keys(ctx.files)).toEqual(Object.keys(PROJECT));
  });

  it('hands the plan to the caller so the UI can show it', async () => {
    const { ctx, spy } = context(PROJECT);
    await runTool('plan_changes', plan, ctx);

    expect(spy.plans).toHaveLength(1);
    expect(spy.plans[0].changes[0].path).toBe('src/Settings.tsx');
  });

  it('works without a caller listening', async () => {
    const { ctx } = context(PROJECT, { onPlan: undefined });

    await expect(runTool('plan_changes', plan, ctx)).resolves.toContain('src/Settings.tsx');
  });

  /** A bad plan is a message the model can act on, not a crash. */
  it('reports an invalid plan as a tool error', async () => {
    const { ctx } = context(PROJECT);

    await expect(
      runTool(
        'plan_changes',
        { goal: 'g', changes: [{ path: 'src/App.tsx', operation: 'create', reason: 'r' }] },
        ctx,
      ),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('who may use them', () => {
  /** Comprehension is not editing; a reviewer must keep all three. */
  it.each(['get_project_intelligence', 'find_related_code', 'plan_changes'])(
    '%s is available to a read-only user',
    (name) => {
      expect(toolsFor(false).map((tool) => tool.name)).toContain(name);
    },
  );

  it.each(['get_project_intelligence', 'find_related_code', 'plan_changes'])(
    '%s is not marked as a mutation',
    (name) => {
      expect(TOOLS.find((tool) => tool.name === name)?.mutates).toBe(false);
    },
  );

  it('a read-only user can actually run plan_changes', async () => {
    const { ctx, spy } = context(PROJECT, { canWrite: false });
    await runTool(
      'plan_changes',
      { goal: 'g', changes: [{ path: 'src/New.tsx', operation: 'create', reason: 'r' }] },
      ctx,
    );

    expect(spy.writes).toEqual([]);
    expect(spy.plans).toHaveLength(1);
  });
});
