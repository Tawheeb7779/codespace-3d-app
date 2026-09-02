import { describe, expect, it } from 'vitest';
import { atLeast, capabilitiesFor, roleRank, ROLE_ORDER } from '@/lib/permissions';
import { runTool, toolsFor, ToolError } from '@/lib/ai/tools';
import type { ToolContext } from '@/lib/ai/tools';

describe('roles', () => {
  it('orders roles from least to most privileged', () => {
    expect(ROLE_ORDER).toEqual(['viewer', 'editor', 'admin', 'owner']);
    expect(roleRank('owner')).toBeGreaterThan(roleRank('viewer'));
  });

  it('compares roles inclusively', () => {
    expect(atLeast('editor', 'editor')).toBe(true);
    expect(atLeast('viewer', 'editor')).toBe(false);
    expect(atLeast('admin', 'editor')).toBe(true);
  });

  it('grants write from editor upwards and delete only to the owner', () => {
    expect(capabilitiesFor('viewer')).toMatchObject({ read: true, write: false, deleteProject: false });
    expect(capabilitiesFor('editor')).toMatchObject({ write: true, manageMembers: false });
    expect(capabilitiesFor('admin')).toMatchObject({ write: true, manageMembers: true, deleteProject: false });
    expect(capabilitiesFor('owner')).toMatchObject({ write: true, deleteProject: true });
  });
});

function context(canWrite: boolean): ToolContext & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    files: { 'src/a.ts': 'const a = 1;\n', '.env': 'SECRET=1' },
    dirs: [],
    canWrite,
    writeFile(path, content) {
      written[path] = content;
    },
    deletePath(path) {
      delete written[path];
    },
    async runShell() {
      return 'ran';
    },
    terminalOutput: () => 'output',
  };
}

describe('AI tool permissions', () => {
  it('hides mutating tools from read-only callers', () => {
    const names = toolsFor(false).map((tool) => tool.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(toolsFor(true).map((t) => t.name)).toContain('write_file');
  });

  // Hiding the tool is not enough: a model can still name it.
  it('refuses a mutating tool call from a read-only caller', async () => {
    await expect(
      runTool('write_file', { path: 'src/b.ts', content: 'x' }, context(false)),
    ).rejects.toThrow(/read-only/);
  });

  it('blocks writes outside the project root', async () => {
    await expect(
      runTool('write_file', { path: '../escape.ts', content: 'x' }, context(true)),
    ).rejects.toThrow(/escapes the project root/);
  });

  it('blocks access to protected paths', async () => {
    await expect(runTool('read_file', { path: '.env' }, context(true))).rejects.toThrow(
      /blocked by the workspace policy/,
    );
  });

  it('rejects an unknown tool name', async () => {
    await expect(runTool('rm_rf', {}, context(true))).rejects.toThrow(ToolError);
  });

  it('reads a real file with line numbers', async () => {
    const result = await runTool('read_file', { path: 'src/a.ts' }, context(true));
    expect(result).toContain('1| const a = 1;');
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    const ctx = context(true);
    ctx.files['src/dup.ts'] = 'x\nx\n';
    await expect(
      runTool('edit_file', { path: 'src/dup.ts', old_string: 'x', new_string: 'y' }, ctx),
    ).rejects.toThrow(/appears 2 times/);
  });

  it('reports a missing edit target instead of creating the file', async () => {
    await expect(
      runTool('edit_file', { path: 'src/a.ts', old_string: 'nope', new_string: 'y' }, context(true)),
    ).rejects.toThrow(/was not found/);
  });

  it('performs a unique edit', async () => {
    const ctx = context(true);
    const result = await runTool(
      'edit_file',
      { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      ctx,
    );
    expect(result).toBe('Edited src/a.ts');
    expect(ctx.written['src/a.ts']).toBe('const a = 2;\n');
  });

  it('validates argument types', async () => {
    await expect(runTool('read_file', { path: 42 }, context(true))).rejects.toThrow(
      /must be a string/,
    );
  });
});
