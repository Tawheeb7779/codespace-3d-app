import { describe, expect, it } from 'vitest';
import { atLeast, capabilitiesFor, roleRank, ROLE_ORDER } from '@/lib/permissions';
import {
  isDestructiveCommand,
  MAX_WRITE_BYTES,
  runTool,
  toolsFor,
  ToolError,
} from '@/lib/ai/tools';
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

function context(
  canWrite: boolean,
  allowDestructive = false,
): ToolContext & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    files: { 'src/a.ts': 'const a = 1;\n', '.env': 'SECRET=1' },
    dirs: [],
    canWrite,
    allowDestructive,
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

  it('rejects every traversal shape on every path-taking tool', async () => {
    const attempts = ['../escape.ts', '../../etc/passwd', '/../../root/.ssh/id_rsa', '..\\..\\win'];
    for (const path of attempts) {
      await expect(runTool('read_file', { path }, context(true))).rejects.toThrow();
      await expect(runTool('write_file', { path, content: 'x' }, context(true))).rejects.toThrow();
      await expect(
        runTool('edit_file', { path, old_string: 'a', new_string: 'b' }, context(true)),
      ).rejects.toThrow();
      await expect(runTool('delete_file', { path }, context(true, true))).rejects.toThrow();
    }
  });

  it.each(['.env', '.git/config', 'node_modules/react/index.js'])(
    'blocks the protected path %s on write as well as read',
    async (path) => {
      await expect(runTool('write_file', { path, content: 'x' }, context(true))).rejects.toThrow(
        /blocked by the workspace policy/,
      );
    },
  );
});

describe('destructive-action approval', () => {
  it('refuses delete_file until the user opts in', async () => {
    const ctx = context(true, false);
    ctx.files['src/gone.ts'] = 'x';
    await expect(runTool('delete_file', { path: 'src/gone.ts' }, ctx)).rejects.toThrow(
      /destructive actions are off/,
    );
  });

  it('allows delete_file once approved', async () => {
    const ctx = context(true, true);
    ctx.files['src/gone.ts'] = 'x';
    ctx.written['src/gone.ts'] = 'x';
    await expect(runTool('delete_file', { path: 'src/gone.ts' }, ctx)).resolves.toMatch(/Deleted/);
    expect(ctx.written['src/gone.ts']).toBeUndefined();
  });

  it('reports a missing file before asking for approval', async () => {
    await expect(runTool('delete_file', { path: 'src/absent.ts' }, context(true))).rejects.toThrow(
      /No such file/,
    );
  });

  it('classifies destructive shell commands', () => {
    expect(isDestructiveCommand('rm -r src')).toBe(true);
    expect(isDestructiveCommand('  RM file')).toBe(true);
    expect(isDestructiveCommand('ls -l')).toBe(false);
    expect(isDestructiveCommand('git status')).toBe(false);
    // Not a prefix match: a command that merely starts with the letters is fine.
    expect(isDestructiveCommand('rmdir x')).toBe(false);
  });

  it('gates a destructive run_command but lets ordinary ones through', async () => {
    await expect(runTool('run_command', { command: 'rm -r src' }, context(true))).rejects.toThrow(
      /destructive actions are off/,
    );
    await expect(runTool('run_command', { command: 'ls' }, context(true))).resolves.toBe('ran');
    await expect(
      runTool('run_command', { command: 'rm -r src' }, context(true, true)),
    ).resolves.toBe('ran');
  });

  // Approval is not a substitute for permission.
  it('still refuses destructive tools for a read-only role even when approved', async () => {
    await expect(runTool('delete_file', { path: 'src/a.ts' }, context(false, true))).rejects.toThrow(
      /read-only/,
    );
    await expect(
      runTool('run_command', { command: 'rm x' }, context(false, true)),
    ).rejects.toThrow(/read-only/);
  });
});

describe('write size limits', () => {
  it('refuses a write over the per-file limit', async () => {
    const huge = 'x'.repeat(MAX_WRITE_BYTES + 1);
    await expect(
      runTool('write_file', { path: 'src/big.ts', content: huge }, context(true)),
    ).rejects.toThrow(/per-file limit/);
  });

  it('accepts a write at the limit', async () => {
    const ctx = context(true);
    const atLimit = 'x'.repeat(MAX_WRITE_BYTES);
    await expect(
      runTool('write_file', { path: 'src/big.ts', content: atLimit }, ctx),
    ).resolves.toMatch(/^Wrote/);
  });

  it('refuses an edit that would push a file over the limit', async () => {
    const ctx = context(true);
    ctx.files['src/a.ts'] = 'const a = 1;\n';
    await expect(
      runTool(
        'edit_file',
        { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'y'.repeat(MAX_WRITE_BYTES + 1) },
        ctx,
      ),
    ).rejects.toThrow(/size limit/);
  });
});
