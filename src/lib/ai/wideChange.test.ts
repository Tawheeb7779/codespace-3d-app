// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '@/lib/ai/tools';
import { WIDE_CHANGE_THRESHOLD } from '@/lib/ai/approval';

/**
 * The check-in partway through a long run of edits.
 *
 * A single edit is recoverable and runs unattended by design. What needs a
 * human is the pattern: twenty files into a task nobody watched. The rule was
 * classified but never enforced, so an agent could rewrite the whole project
 * without pausing once — these tests hold the enforcement in place.
 */

interface Harness {
  ctx: ToolContext;
  asked: string[];
  files: Record<string, string>;
}

function harness(options: {
  changed: number;
  grant: boolean;
  threshold?: number | null;
}): Harness {
  const files: Record<string, string> = { 'src/a.ts': 'const a = 1;' };
  const asked: string[] = [];
  return {
    files,
    asked,
    ctx: {
      files,
      dirs: [],
      canWrite: true,
      allowDestructive: false,
      writeFile: (path, content) => {
        files[path] = content;
      },
      deletePath: (path) => {
        delete files[path];
      },
      runShell: async () => 'ok',
      terminalOutput: () => '',
      changedSoFar: () => options.changed,
      wideChangeThreshold: options.threshold,
      requestApproval: async (action) => {
        asked.push(action);
        return options.grant;
      },
    },
  };
}

const write = (ctx: ToolContext) =>
  runTool('write_file', { path: 'src/new.ts', content: 'export const b = 2;' }, ctx);

const edit = (ctx: ToolContext) =>
  runTool('edit_file', { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);

describe('editing below the threshold', () => {
  it('runs unattended, because a single edit is recoverable', async () => {
    const h = harness({ changed: WIDE_CHANGE_THRESHOLD - 1, grant: false });
    await write(h.ctx);
    await edit(h.ctx);
    expect(h.asked).toEqual([]);
    expect(h.files['src/new.ts']).toBe('export const b = 2;');
    expect(h.files['src/a.ts']).toBe('const a = 2;');
  });
});

describe('editing at the threshold', () => {
  it('stops and asks, naming how far the task has already gone', async () => {
    const h = harness({ changed: WIDE_CHANGE_THRESHOLD, grant: true });
    await write(h.ctx);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain(String(WIDE_CHANGE_THRESHOLD));
    expect(h.asked[0]).toContain('src/new.ts');
  });

  it('writes the file once approved', async () => {
    const h = harness({ changed: WIDE_CHANGE_THRESHOLD, grant: true });
    await write(h.ctx);
    expect(h.files['src/new.ts']).toBe('export const b = 2;');
  });

  /** Declining has to actually stop the write, not just record a refusal. */
  it('leaves the file untouched when declined', async () => {
    const h = harness({ changed: WIDE_CHANGE_THRESHOLD, grant: false });
    await expect(write(h.ctx)).rejects.toThrow(/declined/);
    expect(h.files).not.toHaveProperty('src/new.ts');

    await expect(edit(h.ctx)).rejects.toThrow(/declined/);
    expect(h.files['src/a.ts']).toBe('const a = 1;');
  });
});

describe('the threshold is configurable', () => {
  it('never checks in when turned off', async () => {
    const h = harness({ changed: 500, grant: false, threshold: null });
    await write(h.ctx);
    expect(h.asked).toEqual([]);
    expect(h.files['src/new.ts']).toBe('export const b = 2;');
  });

  it('checks in sooner when set lower', async () => {
    const h = harness({ changed: 2, grant: true, threshold: 2 });
    await write(h.ctx);
    expect(h.asked).toHaveLength(1);
  });

  /**
   * A caller with no notion of a running task — a script, a test — must not
   * be stopped by a rule about a task that does not exist.
   */
  it('does not apply without a task to count against', async () => {
    const files: Record<string, string> = {};
    await runTool(
      'write_file',
      { path: 'src/new.ts', content: 'x' },
      {
        files,
        dirs: [],
        canWrite: true,
        allowDestructive: false,
        writeFile: (path, content) => {
          files[path] = content;
        },
        deletePath: () => {},
        runShell: async () => '',
        terminalOutput: () => '',
      },
    );
    expect(files['src/new.ts']).toBe('x');
  });
});
