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

describe('directories', () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    host = makeHost({ 'README.md': '# Demo', 'src/a.ts': 'const a = 1;' });
  });

  it('mkdir creates nested directories', async () => {
    const result = await execute('mkdir src/deep/nested', session(), host);
    expect(result.exitCode).toBe(0);
    expect(host.dirs).toContain('src/deep/nested');
  });

  it('mkdir accepts several operands', async () => {
    await execute('mkdir docs assets', session(), host);
    expect(host.dirs).toEqual(expect.arrayContaining(['docs', 'assets']));
  });

  it('mkdir without an operand explains itself', async () => {
    const result = await execute('mkdir', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/missing operand/);
  });

  it('pwd tracks cd, including back to the root', async () => {
    const state = session();
    expect(text((await execute('pwd', state, host)).lines)).toBe('/');
    await execute('cd src', state, host);
    expect(text((await execute('pwd', state, host)).lines)).toBe('/src');
    await execute('cd ..', state, host);
    expect(text((await execute('pwd', state, host)).lines)).toBe('/');
  });

  it('cd navigates into and back out of nested directories', async () => {
    const state = session();
    await execute('mkdir src/deep/nested', state, host);
    await execute('cd src/deep/nested', state, host);
    expect(state.cwd).toBe('src/deep/nested');
    await execute('cd ../..', state, host);
    expect(state.cwd).toBe('src');
    await execute('cd /', state, host);
    expect(state.cwd).toBe('');
  });

  it('cd refuses to climb above the project root', async () => {
    const state = session();
    const result = await execute('cd ../..', state, host);
    expect(result.exitCode).toBe(1);
    expect(state.cwd).toBe('');
  });

  it('relative commands operate inside the working directory', async () => {
    const state = session();
    await execute('cd src', state, host);
    await execute('touch b.ts', state, host);
    expect(host.files['src/b.ts']).toBe('');
    const listing = text((await execute('ls', state, host)).lines);
    expect(listing).toContain('a.ts');
    expect(listing).toContain('b.ts');
    expect(listing).not.toContain('README.md');
  });

  it('tree prints nested structure', async () => {
    await execute('mkdir src/deep', session(), host);
    host.files['src/deep/c.ts'] = 'x';
    const result = await execute('tree', session(), host);
    const body = text(result.lines);
    expect(body).toContain('src/');
    expect(body).toContain('c.ts');
  });
});

describe('malformed and hostile paths', () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    host = makeHost({ 'README.md': '# Demo', 'src/a.ts': 'x' });
  });

  // The shell is a full surface onto the file system; every one of these must
  // be refused with a message rather than silently doing something.
  it.each([
    'cat ../../../etc/passwd',
    'cat ../../secrets',
    'touch ../escape.ts',
    'mkdir ../../evil',
    'rm -r ..',
    'cp src/a.ts ../../out.ts',
    'mv src/a.ts ../../out.ts',
    'echo hi > ../../escape.txt',
  ])('refuses %s', async (command) => {
    const result = await execute(command, session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/escapes the project root|no such|Already at/i);
    expect(Object.keys(host.files).sort()).toEqual(['README.md', 'src/a.ts']);
  });

  it('refuses illegal characters in a new path', async () => {
    const result = await execute('touch "src/a<b>.ts"', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/illegal characters/);
  });

  it('refuses a Windows reserved name', async () => {
    const result = await execute('touch src/CON', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/reserved name/);
  });

  it('refuses a backslash traversal', async () => {
    const result = await execute('cat ..\\..\\etc\\passwd', session(), host);
    expect(result.exitCode).toBe(1);
  });

  it('reports an unreadable directory rather than printing nothing', async () => {
    const result = await execute('cat src', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/no such file/);
  });

  it('cp onto a directory places the file inside it', async () => {
    host.dirs.push('docs');
    await execute('cp src/a.ts docs', session(), host);
    expect(host.files['docs/a.ts']).toBe('x');
  });

  it('mv refuses to move a directory into itself', async () => {
    host.dirs.push('src/inner');
    const result = await execute('mv src src/inner', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/into itself/);
  });

  it('rm -r removes a directory and everything under it', async () => {
    host.files['src/deep/b.ts'] = 'y';
    const result = await execute('rm -r src', session(), host);
    expect(result.exitCode).toBe(0);
    expect(Object.keys(host.files)).toEqual(['README.md']);
  });
});

describe('redirection and reading', () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    host = makeHost({});
  });

  it('overwrites with > and appends with >>', async () => {
    await execute('echo first > log.txt', session(), host);
    expect(host.files['log.txt']).toBe('first\n');
    await execute('echo second >> log.txt', session(), host);
    expect(host.files['log.txt']).toBe('first\nsecond\n');
    await execute('echo replaced > log.txt', session(), host);
    expect(host.files['log.txt']).toBe('replaced\n');
  });

  it('preserves quoted content through redirection', async () => {
    await execute(`echo '{"a": 1}' > data.json`, session(), host);
    expect(host.files['data.json']).toBe('{"a": 1}\n');
    expect(() => JSON.parse(host.files['data.json'])).not.toThrow();
  });

  it('creates intermediate directories when redirecting into a new path', async () => {
    await execute('echo hi > a/b/c.txt', session(), host);
    expect(host.files['a/b/c.txt']).toBe('hi\n');
  });

  it('reports a missing redirection target', async () => {
    const result = await execute('echo hi >', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/missing redirection target/);
  });

  it('head and tail slice a file', async () => {
    host.files['lines.txt'] = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(text((await execute('head -n 2 lines.txt', session(), host)).lines)).toBe('a\nb');
    expect(text((await execute('tail -n 2 lines.txt', session(), host)).lines)).toBe('d\ne');
  });

  it('rejects an invalid line count', async () => {
    host.files['lines.txt'] = 'a';
    const result = await execute('head -n zero lines.txt', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/invalid line count/);
  });

  it('find matches by substring and reports no matches distinctly', async () => {
    host.files['src/alpha.ts'] = '';
    host.files['src/beta.ts'] = '';
    expect(text((await execute('find alpha', session(), host)).lines)).toBe('src/alpha.ts');
    const none = await execute('find zzz', session(), host);
    expect(none.exitCode).toBe(1);
    expect(text(none.lines)).toBe('no matches');
  });

  it('grep reports an invalid pattern instead of throwing', async () => {
    const result = await execute('grep [', session(), host);
    expect(result.exitCode).toBe(1);
    expect(text(result.lines)).toMatch(/invalid pattern/);
  });

  it('stat describes both files and directories', async () => {
    host.files['a.txt'] = 'hello';
    host.dirs.push('docs');
    expect(text((await execute('stat a.txt', session(), host)).lines)).toMatch(/type: file/);
    expect(text((await execute('stat docs', session(), host)).lines)).toMatch(/type: directory/);
  });
});
