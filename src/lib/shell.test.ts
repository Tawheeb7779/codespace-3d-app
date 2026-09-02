import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, resolve, tokenize, type ShellHost, type ShellSession } from '@/lib/shell';

function makeHost(initial: Record<string, string> = {}): ShellHost & {
  files: Record<string, string>;
  dirs: string[];
  opened: string[];
} {
  const files: Record<string, string> = { ...initial };
  const dirs: string[] = [];
  const opened: string[] = [];
  return {
    files,
    dirs,
    opened,
    projectName: 'demo',
    user: 'tester <t@example.com>',
    getFiles: () => files,
    getDirs: () => dirs,
    writeFile: (path, content) => {
      files[path] = content;
    },
    removePath: (path) => {
      for (const key of Object.keys(files)) {
        if (key === path || key.startsWith(`${path}/`)) delete files[key];
      }
    },
    makeDir: (path) => {
      dirs.push(path);
    },
    movePath: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
    openInEditor: (path) => {
      opened.push(path);
    },
    build: async () => [{ kind: 'info', text: 'built' }],
    startPreview: async () => [{ kind: 'info', text: 'running' }],
    stopPreview: () => [{ kind: 'info', text: 'stopped' }],
    npm: async () => [{ kind: 'info', text: 'npm ran' }],
    git: async () => [{ kind: 'info', text: 'git ran' }],
    exportArchive: async () => [{ kind: 'info', text: 'exported' }],
  };
}

const session = (): ShellSession => ({ cwd: '', history: [] });
const text = (lines: { text: string }[]) => lines.map((line) => line.text).join('\n');

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize('echo "hello world" bare')).toEqual(['echo', 'hello world', 'bare']);
    expect(tokenize("echo 'single quoted'")).toEqual(['echo', 'single quoted']);
    expect(tokenize('echo a\\ b')).toEqual(['echo', 'a b']);
  });
});

describe('resolve', () => {
  it('resolves relative to the working directory', () => {
    expect(resolve({ cwd: 'src', history: [] }, 'lib/a.ts')).toBe('src/lib/a.ts');
  });

  it('walks up with .. but stops at the root', () => {
    expect(resolve({ cwd: 'src/lib', history: [] }, '../a.ts')).toBe('src/a.ts');
    expect(() => resolve({ cwd: '', history: [] }, '../a.ts')).toThrow(/escapes the project root/);
  });

  it('treats a leading slash as the project root', () => {
    expect(resolve({ cwd: 'src', history: [] }, '/README.md')).toBe('README.md');
  });
});

describe('execute', () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    host = makeHost({ 'README.md': '# Demo\nsecond line', 'src/a.ts': 'const a = 1;' });
  });

  it('reports unknown commands rather than pretending', async () => {
    const result = await execute('sudo rm -rf /', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toContain('command not found: sudo');
    expect(text(result.lines)).toContain('this shell actually implements');
  });

  it('lists directory contents', async () => {
    const result = await execute('ls', session(), host);
    expect(text(result.lines).split('\n')).toEqual(['src/', 'README.md']);
  });

  it('changes directory and rejects unknown ones', async () => {
    const state = session();
    await execute('cd src', state, host);
    expect(state.cwd).toBe('src');
    const bad = await execute('cd nope', state, host);
    expect(bad.exitCode).toBe(1);
    expect(state.cwd).toBe('src');
  });

  it('prints files and reports missing ones', async () => {
    expect(text((await execute('cat README.md', session(), host)).lines)).toContain('# Demo');
    const missing = await execute('cat nope.txt', session(), host);
    expect(missing.exitCode).toBe(1);
    expect(text(missing.lines)).toContain('no such file');
  });

  it('creates, copies, moves and deletes files', async () => {
    await execute('touch src/b.ts', session(), host);
    expect(host.files['src/b.ts']).toBe('');

    await execute('cp src/a.ts src/c.ts', session(), host);
    expect(host.files['src/c.ts']).toBe('const a = 1;');

    await execute('mv src/c.ts src/d.ts', session(), host);
    expect(host.files['src/d.ts']).toBe('const a = 1;');
    expect(host.files['src/c.ts']).toBeUndefined();

    await execute('rm src/d.ts', session(), host);
    expect(host.files['src/d.ts']).toBeUndefined();
  });

  it('requires -r to delete a directory', async () => {
    const result = await execute('rm src', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toContain('is a directory');
    expect(host.files['src/a.ts']).toBeDefined();
  });

  it('writes and appends with echo redirection', async () => {
    await execute('echo hello > note.txt', session(), host);
    expect(host.files['note.txt']).toBe('hello\n');
    await execute('echo world >> note.txt', session(), host);
    expect(host.files['note.txt']).toBe('hello\nworld\n');
  });

  it('greps file contents', async () => {
    const result = await execute('grep const', session(), host);
    expect(text(result.lines)).toContain('src/a.ts:1');
  });

  it('refuses paths that escape the project root', async () => {
    const result = await execute('cat ../../etc/passwd', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toContain('escapes the project root');
  });

  it('signals a terminal clear rather than clearing state itself', async () => {
    const result = await execute('clear', session(), host);
    expect(result.control).toBe('clear');
  });

  it('lists every command in help', async () => {
    const result = await execute('help', session(), host);
    const body = text(result.lines);
    for (const command of ['ls', 'cat', 'git', 'npm', 'build', 'export']) {
      expect(body).toContain(command);
    }
  });

  it('delegates git, npm and build to the host', async () => {
    const git = vi.spyOn(host, 'git');
    await execute('git status', session(), host);
    expect(git).toHaveBeenCalledWith(['status']);
    expect(text((await execute('build', session(), host)).lines)).toBe('built');
    expect(text((await execute('npm ls', session(), host)).lines)).toBe('npm ran');
  });

  it('opens files in the editor', async () => {
    await execute('open src/a.ts', session(), host);
    expect(host.opened).toEqual(['src/a.ts']);
  });

  it('counts lines, words and bytes', async () => {
    const result = await execute('wc README.md', session(), host);
    expect(result.lines[0].text.startsWith('2\t')).toBe(true);
  });

  it('returns nothing for an empty command line', async () => {
    const result = await execute('   ', session(), host);
    expect(result.lines).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
