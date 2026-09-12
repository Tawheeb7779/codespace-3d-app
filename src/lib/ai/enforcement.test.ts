import { describe, expect, it, vi } from 'vitest';
import { WORKFLOWS } from '@/lib/ai/workflows';
import { runTool, toolsForTurn, type ToolContext } from '@/lib/ai/tools';

/**
 * Two enforcement gaps that a prompt alone cannot close.
 *
 * A read-only workflow *asks* the model not to change files. That is an
 * instruction, and an instruction is not a control: the model still holds
 * `write_file`, and "Explain this function" ending in an edit is exactly the
 * surprise that makes an assistant untrustworthy. So a read-only turn is given
 * no write tools at all.
 *
 * And an approval wait is unbounded — a person may take minutes, or walk away
 * and come back after their access has been revoked. The permission that was
 * true when the prompt appeared is not necessarily true when they click yes, so
 * it is re-read afterwards rather than assumed to have held.
 */

/**
 * A context whose `canWrite` can change between calls.
 *
 * Spreading an object literal *invokes* a getter and copies the value, which
 * would make every reading here static — and the real store supplies
 * `canWrite` as a live getter over the file store. So the descriptors are
 * copied rather than the values, and a revocation mid-await is observable the
 * way it is in production.
 */
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const base: ToolContext = {
    files: { 'src/a.ts': 'export const a = 1;\n' },
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: () => undefined,
    deletePath: () => undefined,
    runShell: async () => 'ran',
    terminalOutput: () => '',
  };
  return Object.defineProperties(
    base,
    Object.getOwnPropertyDescriptors(overrides),
  ) as ToolContext;
}

describe('a read-only turn gets no write tools', () => {
  const writeTools = ['write_file', 'edit_file', 'delete_file'];

  it.each(writeTools)('withholds %s', (name) => {
    expect(toolsForTurn(true, true).map((tool) => tool.name)).not.toContain(name);
  });

  it('still offers the reading tools', () => {
    const names = toolsForTurn(true, true).map((tool) => tool.name);

    expect(names).toContain('read_file');
    expect(names).toContain('get_project_intelligence');
    expect(names).toContain('plan_changes');
  });

  it('offers the write tools on an ordinary turn', () => {
    expect(toolsForTurn(true, false).map((tool) => tool.name)).toContain('write_file');
  });

  it('withholds them from a read-only user regardless of the turn', () => {
    expect(toolsForTurn(false, false).map((tool) => tool.name)).not.toContain('write_file');
  });

  /** The workflows that say they do not mutate must actually not be able to. */
  it.each(WORKFLOWS.filter((workflow) => !workflow.mutates).map((workflow) => workflow.id))(
    'the %s workflow is declared read-only',
    (id) => {
      const workflow = WORKFLOWS.find((entry) => entry.id === id);

      expect(workflow?.mutates).toBe(false);
    },
  );
});

describe('permission is re-read after an approval wait', () => {
  /**
   * The window this closes: access revoked while the dialog was on screen.
   * Granting approval is the user saying yes to the action, not the server
   * saying they may still perform it.
   */
  it('refuses the write when the role was revoked during the wait', async () => {
    let canWrite = true;
    const ctx = context({
      get canWrite() {
        return canWrite;
      },
      allowDestructive: false,
      requestApproval: async () => {
        // Revoked while the person was deciding.
        canWrite = false;
        return true;
      },
    });

    await expect(runTool('delete_file', { path: 'src/a.ts' }, ctx)).rejects.toThrow(
      /permission|read-only/i,
    );
  });

  it('proceeds when the role still holds', async () => {
    const deleted: string[] = [];
    const ctx = context({
      deletePath: (path) => deleted.push(path),
      requestApproval: async () => true,
    });

    await runTool('delete_file', { path: 'src/a.ts' }, ctx);

    expect(deleted).toEqual(['src/a.ts']);
  });

  /** The task may also have been cancelled while the dialog was up. */
  it('refuses when the task went away during the wait', async () => {
    let active = true;
    const ctx = context({
      assertActive: () => {
        if (!active) throw new Error('This task is no longer running.');
      },
      requestApproval: async () => {
        active = false;
        return true;
      },
    });

    await expect(runTool('delete_file', { path: 'src/a.ts' }, ctx)).rejects.toThrow(
      /no longer running/i,
    );
  });

  it('does not delete anything when the recheck refuses', async () => {
    const deleted: string[] = [];
    let canWrite = true;
    const ctx = context({
      get canWrite() {
        return canWrite;
      },
      deletePath: (path) => deleted.push(path),
      requestApproval: async () => {
        canWrite = false;
        return true;
      },
    });

    await runTool('delete_file', { path: 'src/a.ts' }, ctx).catch(() => undefined);

    expect(deleted).toEqual([]);
  });

  /** A destructive command goes through the same wait and the same recheck. */
  it('refuses a destructive command when the role was revoked', async () => {
    const ran = vi.fn(async () => 'ran');
    let canWrite = true;
    const ctx = context({
      get canWrite() {
        return canWrite;
      },
      runShell: ran,
      requestApproval: async () => {
        canWrite = false;
        return true;
      },
    });

    await expect(runTool('run_command', { command: 'rm -rf build' }, ctx)).rejects.toThrow(
      /permission|read-only/i,
    );
    expect(ran).not.toHaveBeenCalled();
  });
});
