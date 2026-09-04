// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_SELECTION, WORKFLOWS, workflowById, type WorkflowScope } from '@/lib/ai/workflows';

/**
 * Workflows are prepared prompts, not a second agent.
 *
 * That is the property worth protecting: everything they produce goes through
 * the same loop, tools and approvals as a typed request, so a workflow can
 * never reach past the boundary. What these tests hold in place is the part
 * that could still go wrong — a workflow that runs when it has nothing to work
 * on, one that quotes a protected file, or a read-only task that reads as
 * permission to edit.
 */

const scope = (overrides: Partial<WorkflowScope> = {}): WorkflowScope => ({
  path: 'src/app.ts',
  selection: '',
  hasDiagnostics: false,
  hasChanges: false,
  ...overrides,
});

describe('availability', () => {
  it('refuses a file workflow with nothing open, and says why', () => {
    const empty = scope({ path: null });
    for (const id of ['explain', 'refactor', 'tests', 'optimize', 'document'] as const) {
      const workflow = workflowById(id)!;
      expect(workflow.unavailable(empty), id).toMatch(/Open a file or select/);
    }
  });

  it('refuses to send a protected file to the model', () => {
    for (const path of ['.env', '.git/config', 'node_modules/x/index.js', '.npmrc']) {
      const blocked = workflowById('explain')!.unavailable(scope({ path }));
      expect(blocked, path).toMatch(/protected/i);
    }
  });

  it('lets a selection stand in for an open file', () => {
    expect(workflowById('explain')!.unavailable(scope({ path: null, selection: 'const x = 1;' })))
      .toBeNull();
  });

  it('will not debug when nothing is failing', () => {
    expect(workflowById('debug')!.unavailable(scope())).toMatch(/Nothing is reporting an error/);
    expect(workflowById('debug')!.unavailable(scope({ hasDiagnostics: true }))).toBeNull();
  });

  it('will not review an unchanged working tree', () => {
    expect(workflowById('review')!.unavailable(scope())).toMatch(/no uncommitted changes/);
    expect(workflowById('review')!.unavailable(scope({ hasChanges: true }))).toBeNull();
  });
});

describe('the prompts say what they mean', () => {
  it('marks read-only workflows read-only, in the prompt itself', () => {
    expect(workflowById('explain')!.prompt(scope())).toMatch(/Do not change any files/);
    expect(workflowById('review')!.prompt(scope({ hasChanges: true }))).toMatch(/Do not edit/);
  });

  it('asks editing workflows to verify with a real build', () => {
    for (const id of ['refactor', 'debug'] as const) {
      expect(workflowById(id)!.prompt(scope({ hasDiagnostics: true })), id).toMatch(/build/i);
    }
  });

  /** There is no test runner in the browser; a workflow must not imply one. */
  it('tells the tests workflow not to claim tests passed', () => {
    const prompt = workflowById('tests')!.prompt(scope());
    expect(prompt).toMatch(/no test runner/i);
    expect(prompt).toMatch(/do not claim the tests pass/i);
  });

  it('names the file when there is no selection, and quotes the selection when there is', () => {
    expect(workflowById('explain')!.prompt(scope())).toContain('src/app.ts');
    const quoted = workflowById('explain')!.prompt(scope({ selection: 'const secretless = 1;' }));
    expect(quoted).toContain('const secretless = 1;');
    expect(quoted).toContain('```');
  });

  it('truncates an enormous selection rather than sending it whole', () => {
    const prompt = workflowById('explain')!.prompt(scope({ selection: 'x'.repeat(50_000) }));
    expect(prompt.length).toBeLessThan(MAX_SELECTION + 1000);
    expect(prompt).toContain('truncated');
  });
});

describe('the catalogue is coherent', () => {
  it('has unique ids and no workflow missing its parts', () => {
    const ids = WORKFLOWS.map((workflow) => workflow.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const workflow of WORKFLOWS) {
      expect(workflow.label, workflow.id).toBeTruthy();
      expect(workflow.description, workflow.id).toBeTruthy();
      expect(workflow.prompt(scope({ hasChanges: true, hasDiagnostics: true })).length).toBeGreaterThan(40);
    }
  });

  it('marks exactly the workflows that edit as mutating', () => {
    const mutating = WORKFLOWS.filter((workflow) => workflow.mutates).map((w) => w.id).sort();
    expect(mutating).toEqual(['debug', 'document', 'optimize', 'refactor', 'tests']);
  });

  it('returns nothing for an unknown id', () => {
    expect(workflowById('nope' as never)).toBeUndefined();
  });
});
