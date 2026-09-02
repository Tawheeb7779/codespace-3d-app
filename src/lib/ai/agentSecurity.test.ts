// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, runTool, toolsFor, type ToolContext } from '@/lib/ai/tools';
import { classify } from '@/lib/ai/approval';
import { useAgentStore, agentLockHolder } from '@/stores/agentStore';
import { isTerminal } from '@/lib/ai/task';

/**
 * The boundary around the coding agent.
 *
 * The agent runs on the user's behalf with the user's project permissions, and
 * nothing more. These tests assert the three things that would matter most if
 * they were wrong: it cannot leave the project, it cannot reach a credential,
 * and it cannot destroy work without being told to.
 */

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const files: Record<string, string> = { 'src/a.ts': 'a', '.env': 'SECRET=1' };
  return {
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
    ...overrides,
  };
}

/** Paths that must never resolve, whatever the model asks for. */
const ESCAPES = [
  '../../etc/passwd',
  '../outside.txt',
  '/etc/passwd',
  '/home/user/.ssh/id_rsa',
  'src/../../escape.ts',
  '..\\..\\windows\\system32',
  'src/./../../out.ts',
  './../../x',
];

const PROTECTED = [
  '.env',
  '.git/config',
  '.git/HEAD',
  'node_modules/left-pad/index.js',
  '.ssh/id_rsa',
  '.npmrc',
  '.aws/credentials',
];

describe('the agent cannot leave the project', () => {
  it('rejects every traversing path on every file tool', async () => {
    for (const path of ESCAPES) {
      await expect(runTool('read_file', { path }, ctx()), path).rejects.toThrow();
      await expect(runTool('write_file', { path, content: 'x' }, ctx()), path).rejects.toThrow();
      await expect(
        runTool('edit_file', { path, old_string: 'a', new_string: 'b' }, ctx()),
        path,
      ).rejects.toThrow();
      await expect(
        runTool('delete_file', { path }, ctx({ allowDestructive: true })),
        path,
      ).rejects.toThrow();
    }
  });

  it('rejects protected paths, .git and .env among them', async () => {
    for (const path of PROTECTED) {
      await expect(runTool('read_file', { path }, ctx()), path).rejects.toThrow(/blocked|No such/);
      await expect(runTool('write_file', { path, content: 'x' }, ctx()), path).rejects.toThrow(
        /blocked/,
      );
    }
  });

  it('writes nothing when a path is rejected', async () => {
    const context = ctx();
    const before = { ...context.files };
    for (const path of [...ESCAPES, ...PROTECTED]) {
      await runTool('write_file', { path, content: 'pwned' }, context).catch(() => undefined);
    }
    expect(context.files).toEqual(before);
  });

  it('refuses an unknown tool rather than guessing', async () => {
    await expect(runTool('exec_host', { command: 'id' }, ctx())).rejects.toThrow(/Unknown tool/);
    await expect(runTool('read_host_file', { path: '/etc/passwd' }, ctx())).rejects.toThrow();
  });

  /** The shell the agent reaches is the project interpreter, not a host shell. */
  it('exposes no tool that could reach the host system', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain('exec');
    expect(names).not.toContain('eval');
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('http_request');
    // run_command is the only execution surface, and it is the Forge Shell.
    expect(names.filter((n) => /exec|spawn|shell|eval|http|fetch|net/i.test(n))).toEqual([]);
  });
});

describe('the agent cannot reach a credential', () => {
  const source = (file: string) =>
    readFileSync(join(process.cwd(), 'src/lib/ai', file), 'utf8');

  it('has no GitHub tool and no GitHub import', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.filter((n) => /git|github|push|pull|fetch|remote/i.test(n))).toEqual([]);
    for (const file of ['tools.ts', 'agent.ts', 'approval.ts', 'context.ts', 'task.ts']) {
      expect(source(file), file).not.toMatch(/from '@\/lib\/github/);
      expect(source(file), file).not.toMatch(/githubClient|readLocalToken|github_tokens/);
    }
  });

  it('never touches browser storage, where the GitHub token lives', () => {
    for (const file of ['tools.ts', 'agent.ts', 'context.ts']) {
      expect(source(file), file).not.toMatch(/sessionStorage|localStorage|document\.cookie/);
    }
    const runners = TOOLS.map((t) => t.run.toString()).join('\n');
    expect(runners).not.toMatch(/sessionStorage|localStorage|cookie/i);
  });

  it('carries no credential on the tool context', () => {
    const context = ctx();
    const keys = Object.keys(context).join(' ').toLowerCase();
    for (const forbidden of ['token', 'secret', 'apikey', 'key', 'credential', 'password']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('cannot read a .env even with every permission granted', async () => {
    const context = ctx({ canWrite: true, allowDestructive: true });
    await expect(runTool('read_file', { path: '.env' }, context)).rejects.toThrow(/blocked/);
    await expect(runTool('read_file', { path: '.env.local' }, context)).rejects.toThrow(/blocked/);
  });

  /**
   * `read_file` refusing `.env` is worth little if a content search prints the
   * same line. This was a real hole: search ran over every file in the project.
   */
  it('does not surface a protected file through a content search', async () => {
    const files = {
      'src/a.ts': 'const a = 1;',
      '.env': 'SUPABASE_SERVICE_ROLE_KEY=hunter2-value',
      '.git/config': '[remote "origin"]\n  url = https://x@github.com/o/r',
    };
    const context = ctx({ files });
    for (const query of ['hunter2-value', 'SUPABASE_SERVICE_ROLE_KEY', 'github.com/o/r']) {
      const hits = await runTool('search_files', { query }, context);
      // Only the "no matches" line, which echoes the query the model supplied
      // — never a line of the protected file itself.
      expect(hits, query).toBe(`No matches for ${query}`);
      expect(hits, query).not.toContain('.env:');
      expect(hits, query).not.toContain('.git/config:');
    }
    // A search over ordinary files still works.
    expect(await runTool('search_files', { query: 'const a' }, context)).toContain('src/a.ts');
  });

  it('rejects an absolute path instead of rewriting it into the project', async () => {
    const files: Record<string, string> = { 'src/a.ts': 'a' };
    const context = ctx({ files });
    for (const path of ['/etc/passwd', '/tmp/x', 'C:\\Windows\\system32']) {
      await expect(runTool('write_file', { path, content: 'x' }, context), path).rejects.toThrow(
        /absolute path/,
      );
    }
    // Nothing was created under a rewritten name.
    expect(Object.keys(files)).toEqual(['src/a.ts']);
  });
});

describe('permission enforcement', () => {
  it('hides every mutating tool from a read-only caller', () => {
    const names = toolsFor(false).map((t) => t.name);
    for (const write of ['write_file', 'edit_file', 'delete_file', 'run_command']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('refuses a mutating tool even if the model names it directly', async () => {
    const viewer = ctx({ canWrite: false });
    for (const tool of ['write_file', 'edit_file', 'delete_file', 'run_command']) {
      await expect(
        runTool(tool, { path: 'src/a.ts', content: 'x', command: 'ls', old_string: 'a', new_string: 'b' }, viewer),
        tool,
      ).rejects.toThrow(/editor permission/);
    }
  });

  it('still lets a viewer read and verify', async () => {
    const viewer = ctx({
      canWrite: false,
      runBuild: async () => ({ ok: true, report: 'Build succeeded.' }),
    });
    expect(await runTool('read_file', { path: 'src/a.ts' }, viewer)).toContain('a');
    expect(await runTool('run_build', {}, viewer)).toContain('succeeded');
  });
});

describe('destructive actions need consent', () => {
  it('classifies every irreversible action as needing approval', () => {
    expect(classify({ tool: 'delete_file', input: { path: 'a' }, changedSoFar: 0 }).decision).toBe('ask');
    for (const command of ['rm x', 'rm -rf /', 'RM -RF src']) {
      expect(
        classify({ tool: 'run_command', input: { command }, changedSoFar: 0 }).decision,
        command,
      ).toBe('ask');
    }
  });

  it('does not run the action when consent is refused', async () => {
    const files = { 'a.ts': 'keep me' };
    const context = ctx({ files, requestApproval: async () => false });
    await expect(runTool('delete_file', { path: 'a.ts' }, context)).rejects.toThrow();
    expect(files['a.ts']).toBe('keep me');
  });
});

describe('task control', () => {
  it('refuses a second task while one holds the project', () => {
    const store = useAgentStore.getState();
    store.finish('completed'); // ensure a clean lock
    const first = store.begin('first task', 'prj_1');
    expect(first).not.toBeNull();
    expect(agentLockHolder()).toBe('prj_1');
    // A concurrent task would interleave writes into the same file system.
    expect(useAgentStore.getState().begin('second task', 'prj_1')).toBeNull();
    expect(useAgentStore.getState().begin('other project', 'prj_2')).toBeNull();
    useAgentStore.getState().finish('completed');
    expect(agentLockHolder()).toBeNull();
  });

  it('releases the lock when a task fails or is cancelled', () => {
    for (const ending of ['failed', 'cancelled'] as const) {
      useAgentStore.getState().begin('t', 'prj');
      useAgentStore.getState().finish(ending);
      expect(agentLockHolder()).toBeNull();
      expect(isTerminal(useAgentStore.getState().task!.phase)).toBe(true);
    }
  });

  it('settles a pending approval when the task is cancelled, rather than hanging', async () => {
    useAgentStore.getState().begin('t', 'prj');
    const pending = useAgentStore
      .getState()
      .requestApproval('Deleting a.ts', ['a.ts'], 'delete_file');
    expect(useAgentStore.getState().task?.phase).toBe('waiting_for_approval');

    useAgentStore.getState().finish('cancelled');
    // The tool call awaiting this promise must not be left dangling.
    await expect(pending).resolves.toBe(false);
    expect(useAgentStore.getState().pending).toBeNull();
  });

  it('records a cancelled task honestly rather than as a success', () => {
    useAgentStore.getState().begin('t', 'prj');
    useAgentStore.getState().noteChange('a.ts', 'modified', 'x', 'y');
    useAgentStore.getState().finish('cancelled');
    const task = useAgentStore.getState().task!;
    expect(task.phase).toBe('cancelled');
    // What it did get done is still reported.
    expect(task.summary).toContain('1 modified');
    expect(useAgentStore.getState().history[0].phase).toBe('cancelled');
  });
});
