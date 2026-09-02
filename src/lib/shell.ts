import {
  basename,
  dirname,
  isDescendant,
  joinPath,
  resolveRelative,
  VfsError,
} from '@/lib/vfs';
import { formatBytes, byteLength } from '@/lib/utils';

/**
 * Forge Shell — a command interpreter over the project's virtual file system.
 *
 * It is **not** a POSIX shell and never claims to be: there is no operating
 * system, no processes and no network shell behind it. Every command listed by
 * `help` performs a real operation on the workspace (or a real registry/build
 * call); anything not implemented reports "command not found" rather than
 * printing plausible output.
 */

export type LineKind = 'stdout' | 'stderr' | 'info' | 'command';

export interface ShellLine {
  kind: LineKind;
  text: string;
}

export interface ShellResult {
  lines: ShellLine[];
  /** Terminal-level side effect the caller must apply. */
  control?: 'clear';
  exitCode: number;
}

export interface ShellHost {
  projectName: string;
  user: string;
  getFiles(): Record<string, string>;
  getDirs(): string[];
  writeFile(path: string, content: string): void;
  removePath(path: string): void;
  makeDir(path: string): void;
  movePath(from: string, to: string): void;
  openInEditor(path: string): void;
  /** Runs the real bundler and returns its diagnostics. */
  build(): Promise<ShellLine[]>;
  startPreview(): Promise<ShellLine[]>;
  stopPreview(): ShellLine[];
  npm(args: string[]): Promise<ShellLine[]>;
  git(args: string[]): Promise<ShellLine[]>;
  exportArchive(): Promise<ShellLine[]>;
}

export interface ShellSession {
  cwd: string;
  history: string[];
}

const out = (text: string): ShellLine => ({ kind: 'stdout', text });
const err = (text: string): ShellLine => ({ kind: 'stderr', text });
const info = (text: string): ShellLine => ({ kind: 'info', text });

const ok = (lines: ShellLine[]): ShellResult => ({ lines, exitCode: 0 });
const fail = (lines: ShellLine[]): ShellResult => ({ lines, exitCode: 1 });

interface CommandDef {
  name: string;
  usage: string;
  summary: string;
  run: (
    args: string[],
    session: ShellSession,
    host: ShellHost,
  ) => ShellResult | Promise<ShellResult>;
}

/** Split a command line honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Resolve a shell argument against the session's working directory. */
export function resolve(session: ShellSession, target: string): string {
  if (!target || target === '.') {
    if (!session.cwd) throw new VfsError('Already at the project root');
    return session.cwd;
  }
  if (target === '..') {
    if (!session.cwd) throw new VfsError('Already at the project root');
    return dirname(session.cwd);
  }
  // `~` means the project root here; there is no home directory.
  const spec = target.startsWith('~') ? target.replace(/^~\/?/, '/') : target;
  try {
    return resolveRelative(session.cwd, spec);
  } catch (error) {
    // `cd /` and `cd ~` legitimately name the project root, which
    // resolveRelative refuses to return as a path. Commands that cannot act on
    // a directory reject the empty path themselves.
    if (error instanceof VfsError && /resolves to the project root/.test(error.message)) return '';
    throw error;
  }
}

function dirExists(host: ShellHost, path: string): boolean {
  if (path === '') return true;
  if (host.getDirs().includes(path)) return true;
  return Object.keys(host.getFiles()).some((file) => file.startsWith(`${path}/`));
}

function listDir(host: ShellHost, path: string): { dirs: string[]; files: string[] } {
  const prefix = path ? `${path}/` : '';
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const file of Object.keys(host.getFiles())) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) files.push(rest);
    else dirs.add(rest.slice(0, slash));
  }
  for (const dir of host.getDirs()) {
    if (!dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (!rest) continue;
    dirs.add(rest.split('/')[0]);
  }
  return { dirs: [...dirs].sort(), files: files.sort() };
}

const COMMANDS: CommandDef[] = [
  {
    name: 'help',
    usage: 'help [command]',
    summary: 'List commands, or show usage for one',
    run: (args) => {
      if (args[0]) {
        const found = COMMANDS.find((c) => c.name === args[0]);
        if (!found) return fail([err(`help: no such command: ${args[0]}`)]);
        return ok([out(found.usage), out(`  ${found.summary}`)]);
      }
      const width = Math.max(...COMMANDS.map((c) => c.name.length));
      return ok([
        info('Forge Shell — commands run against this project\'s virtual file system.'),
        info('There is no host operating system here; unlisted commands are not simulated.'),
        out(''),
        ...COMMANDS.map((c) => out(`  ${c.name.padEnd(width + 2)}${c.summary}`)),
      ]);
    },
  },
  {
    name: 'clear',
    usage: 'clear',
    summary: 'Clear this terminal',
    run: () => ({ lines: [], control: 'clear', exitCode: 0 }),
  },
  {
    name: 'pwd',
    usage: 'pwd',
    summary: 'Print the working directory',
    run: (_args, session) => ok([out(`/${session.cwd}`)]),
  },
  {
    name: 'cd',
    usage: 'cd [dir]',
    summary: 'Change the working directory',
    run: (args, session, host) => {
      const target = args[0] ? resolve(session, args[0]) : '';
      if (target !== '' && !dirExists(host, target)) {
        return fail([err(`cd: no such directory: ${args[0]}`)]);
      }
      session.cwd = target;
      return ok([]);
    },
  },
  {
    name: 'ls',
    usage: 'ls [-l] [dir]',
    summary: 'List directory contents',
    run: (args, session, host) => {
      const long = args.includes('-l');
      const target = args.find((a) => !a.startsWith('-'));
      const path = target ? resolve(session, target) : session.cwd;
      const files = host.getFiles();
      if (path in files) return ok([out(path)]);
      if (!dirExists(host, path)) return fail([err(`ls: no such directory: ${target ?? path}`)]);
      const { dirs, files: names } = listDir(host, path);
      if (!dirs.length && !names.length) return ok([info('(empty directory)')]);
      if (!long) {
        return ok([...dirs.map((d) => out(`${d}/`)), ...names.map((f) => out(f))]);
      }
      return ok([
        ...dirs.map((d) => out(`drwx  ${'-'.padStart(8)}  ${d}/`)),
        ...names.map((f) => {
          const size = byteLength(files[joinPath(path, f)] ?? '');
          return out(`-rw-  ${formatBytes(size).padStart(8)}  ${f}`);
        }),
      ]);
    },
  },
  {
    name: 'tree',
    usage: 'tree [dir]',
    summary: 'Print the directory tree',
    run: (args, session, host) => {
      const root = args[0] ? resolve(session, args[0]) : session.cwd;
      if (!dirExists(host, root)) return fail([err(`tree: no such directory: ${args[0] ?? root}`)]);
      const lines: ShellLine[] = [out(`/${root}`)];
      let count = 0;
      const walk = (path: string, prefix: string) => {
        const { dirs, files } = listDir(host, path);
        const entries = [...dirs.map((d) => ({ name: d, dir: true })), ...files.map((f) => ({ name: f, dir: false }))];
        entries.forEach((entry, index) => {
          if (count++ > 500) return;
          const last = index === entries.length - 1;
          lines.push(out(`${prefix}${last ? '└── ' : '├── '}${entry.name}${entry.dir ? '/' : ''}`));
          if (entry.dir) walk(joinPath(path, entry.name), `${prefix}${last ? '    ' : '│   '}`);
        });
      };
      walk(root, '');
      if (count > 500) lines.push(info('… output truncated at 500 entries'));
      return ok(lines);
    },
  },
  {
    name: 'cat',
    usage: 'cat <file...>',
    summary: 'Print file contents',
    run: (args, session, host) => {
      if (!args.length) return fail([err('cat: missing file operand')]);
      const lines: ShellLine[] = [];
      let code = 0;
      for (const arg of args) {
        const path = resolve(session, arg);
        const content = host.getFiles()[path];
        if (content === undefined) {
          lines.push(err(`cat: ${arg}: no such file`));
          code = 1;
          continue;
        }
        content.split('\n').forEach((line) => lines.push(out(line)));
      }
      return { lines, exitCode: code };
    },
  },
  {
    name: 'head',
    usage: 'head [-n count] <file>',
    summary: 'Print the first lines of a file',
    run: (args, session, host) => sliceFile(args, session, host, 'head'),
  },
  {
    name: 'tail',
    usage: 'tail [-n count] <file>',
    summary: 'Print the last lines of a file',
    run: (args, session, host) => sliceFile(args, session, host, 'tail'),
  },
  {
    name: 'touch',
    usage: 'touch <file...>',
    summary: 'Create an empty file if it does not exist',
    run: (args, session, host) => {
      if (!args.length) return fail([err('touch: missing file operand')]);
      const lines: ShellLine[] = [];
      for (const arg of args) {
        const path = resolve(session, arg);
        if (path in host.getFiles()) continue;
        host.writeFile(path, '');
        lines.push(info(`created ${path}`));
      }
      return ok(lines);
    },
  },
  {
    name: 'mkdir',
    usage: 'mkdir <dir...>',
    summary: 'Create directories',
    run: (args, session, host) => {
      const targets = args.filter((a) => !a.startsWith('-'));
      if (!targets.length) return fail([err('mkdir: missing operand')]);
      const lines: ShellLine[] = [];
      for (const arg of targets) {
        const path = resolve(session, arg);
        host.makeDir(path);
        lines.push(info(`created ${path}/`));
      }
      return ok(lines);
    },
  },
  {
    name: 'rm',
    usage: 'rm [-r] <path...>',
    summary: 'Delete files or directories',
    run: (args, session, host) => {
      const recursive = args.some((a) => /^-[rf]*r/.test(a));
      const targets = args.filter((a) => !a.startsWith('-'));
      if (!targets.length) return fail([err('rm: missing operand')]);
      const files = host.getFiles();
      const lines: ShellLine[] = [];
      let code = 0;
      for (const arg of targets) {
        const path = resolve(session, arg);
        const isFile = path in files;
        const isDir = dirExists(host, path) && path !== '';
        if (!isFile && !isDir) {
          lines.push(err(`rm: ${arg}: no such file or directory`));
          code = 1;
          continue;
        }
        if (!isFile && isDir && !recursive) {
          lines.push(err(`rm: ${arg}: is a directory (use -r)`));
          code = 1;
          continue;
        }
        host.removePath(path);
        lines.push(info(`removed ${path}`));
      }
      return { lines, exitCode: code };
    },
  },
  {
    name: 'cp',
    usage: 'cp <source> <dest>',
    summary: 'Copy a file',
    run: (args, session, host) => {
      if (args.length < 2) return fail([err('cp: usage: cp <source> <dest>')]);
      const from = resolve(session, args[0]);
      const files = host.getFiles();
      if (!(from in files)) return fail([err(`cp: ${args[0]}: no such file`)]);
      let to = resolve(session, args[1]);
      if (dirExists(host, to) && !(to in files)) to = joinPath(to, basename(from));
      host.writeFile(to, files[from]);
      return ok([info(`copied ${from} -> ${to}`)]);
    },
  },
  {
    name: 'mv',
    usage: 'mv <source> <dest>',
    summary: 'Move or rename a file or directory',
    run: (args, session, host) => {
      if (args.length < 2) return fail([err('mv: usage: mv <source> <dest>')]);
      const from = resolve(session, args[0]);
      const files = host.getFiles();
      let to = resolve(session, args[1]);
      if (from in files) {
        if (dirExists(host, to) && !(to in files)) to = joinPath(to, basename(from));
      } else if (!dirExists(host, from)) {
        return fail([err(`mv: ${args[0]}: no such file or directory`)]);
      }
      if (isDescendant(to, from)) return fail([err('mv: cannot move a directory into itself')]);
      host.movePath(from, to);
      return ok([info(`moved ${from} -> ${to}`)]);
    },
  },
  {
    name: 'echo',
    usage: 'echo <text> [> file]',
    summary: 'Print text, optionally writing it to a file',
    run: (args, session, host) => {
      const redirect = args.findIndex((a) => a === '>' || a === '>>');
      if (redirect === -1) return ok([out(args.join(' '))]);
      const target = args[redirect + 1];
      if (!target) return fail([err('echo: missing redirection target')]);
      const path = resolve(session, target);
      const text = args.slice(0, redirect).join(' ');
      const existing = host.getFiles()[path] ?? '';
      host.writeFile(path, args[redirect] === '>>' ? `${existing}${text}\n` : `${text}\n`);
      return ok([info(`wrote ${path}`)]);
    },
  },
  {
    name: 'grep',
    usage: 'grep [-i] <pattern> [dir]',
    summary: 'Search file contents',
    run: (args, session, host) => {
      const insensitive = args.includes('-i');
      const positional = args.filter((a) => !a.startsWith('-'));
      const pattern = positional[0];
      if (!pattern) return fail([err('grep: missing pattern')]);
      const scope = positional[1] ? resolve(session, positional[1]) : session.cwd;
      let matcher: RegExp;
      try {
        matcher = new RegExp(pattern, insensitive ? 'i' : '');
      } catch (error) {
        return fail([err(`grep: invalid pattern: ${(error as Error).message}`)]);
      }
      const lines: ShellLine[] = [];
      const prefix = scope ? `${scope}/` : '';
      for (const [path, content] of Object.entries(host.getFiles())) {
        if (!path.startsWith(prefix)) continue;
        content.split('\n').forEach((line, index) => {
          if (lines.length < 200 && matcher.test(line)) {
            lines.push(out(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`));
          }
        });
      }
      if (!lines.length) return { lines: [info('no matches')], exitCode: 1 };
      return ok(lines);
    },
  },
  {
    name: 'find',
    usage: 'find [pattern]',
    summary: 'List file paths matching a substring',
    run: (args, session, host) => {
      const needle = args[0]?.toLowerCase() ?? '';
      const prefix = session.cwd ? `${session.cwd}/` : '';
      const matches = Object.keys(host.getFiles())
        .filter((p) => p.startsWith(prefix) && p.toLowerCase().includes(needle))
        .sort();
      if (!matches.length) return { lines: [info('no matches')], exitCode: 1 };
      return ok(matches.slice(0, 300).map((p) => out(p)));
    },
  },
  {
    name: 'wc',
    usage: 'wc <file>',
    summary: 'Count lines, words and bytes',
    run: (args, session, host) => {
      if (!args[0]) return fail([err('wc: missing file operand')]);
      const path = resolve(session, args[0]);
      const content = host.getFiles()[path];
      if (content === undefined) return fail([err(`wc: ${args[0]}: no such file`)]);
      const lines = content ? content.split('\n').length : 0;
      const words = content.split(/\s+/).filter(Boolean).length;
      return ok([out(`${lines}\t${words}\t${byteLength(content)}\t${path}`)]);
    },
  },
  {
    name: 'stat',
    usage: 'stat <path>',
    summary: 'Show metadata for a file',
    run: (args, session, host) => {
      if (!args[0]) return fail([err('stat: missing operand')]);
      const path = resolve(session, args[0]);
      const content = host.getFiles()[path];
      if (content === undefined) {
        if (dirExists(host, path)) {
          const { dirs, files } = listDir(host, path);
          return ok([out(`${path}/`), out(`  type: directory`), out(`  entries: ${dirs.length + files.length}`)]);
        }
        return fail([err(`stat: ${args[0]}: no such file or directory`)]);
      }
      return ok([
        out(path),
        out(`  type: file`),
        out(`  size: ${formatBytes(byteLength(content))}`),
        out(`  lines: ${content.split('\n').length}`),
      ]);
    },
  },
  {
    name: 'open',
    usage: 'open <file>',
    summary: 'Open a file in the editor',
    run: (args, session, host) => {
      if (!args[0]) return fail([err('open: missing file operand')]);
      const path = resolve(session, args[0]);
      if (!(path in host.getFiles())) return fail([err(`open: ${args[0]}: no such file`)]);
      host.openInEditor(path);
      return ok([info(`opened ${path}`)]);
    },
  },
  {
    name: 'npm',
    usage: 'npm <install|uninstall|ls> [package]',
    summary: 'Manage package.json dependencies via the npm registry',
    run: (args, _session, host) => host.npm(args).then((lines) => ({
      lines,
      exitCode: lines.some((l) => l.kind === 'stderr') ? 1 : 0,
    })),
  },
  {
    name: 'git',
    usage: 'git <init|status|add|commit|log|branch|checkout|merge|diff>',
    summary: 'Forge VCS — local, git-style version control',
    run: (args, _session, host) => host.git(args).then((lines) => ({
      lines,
      exitCode: lines.some((l) => l.kind === 'stderr') ? 1 : 0,
    })),
  },
  {
    name: 'build',
    usage: 'build',
    summary: 'Bundle the project with esbuild and report diagnostics',
    run: (_args, _session, host) => host.build().then((lines) => ({
      lines,
      exitCode: lines.some((l) => l.kind === 'stderr') ? 1 : 0,
    })),
  },
  {
    name: 'run',
    usage: 'run',
    summary: 'Build and start the live preview',
    run: (_args, _session, host) => host.startPreview().then((lines) => ({
      lines,
      exitCode: lines.some((l) => l.kind === 'stderr') ? 1 : 0,
    })),
  },
  {
    name: 'stop',
    usage: 'stop',
    summary: 'Stop the live preview',
    run: (_args, _session, host) => ok(host.stopPreview()),
  },
  {
    name: 'export',
    usage: 'export',
    summary: 'Download the project as a ZIP archive',
    run: (_args, _session, host) => host.exportArchive().then((lines) => ok(lines)),
  },
  {
    name: 'history',
    usage: 'history',
    summary: 'Show this session\'s command history',
    run: (_args, session) =>
      ok(session.history.map((entry, index) => out(`${String(index + 1).padStart(4)}  ${entry}`))),
  },
  {
    name: 'whoami',
    usage: 'whoami',
    summary: 'Print the signed-in user',
    run: (_args, _session, host) => ok([out(host.user)]),
  },
  {
    name: 'date',
    usage: 'date',
    summary: 'Print the current date and time',
    run: () => ok([out(new Date().toString())]),
  },
  {
    name: 'env',
    usage: 'env',
    summary: 'Show the shell environment',
    run: (_args, session, host) =>
      ok([
        out(`PROJECT=${host.projectName}`),
        out(`USER=${host.user}`),
        out(`PWD=/${session.cwd}`),
        out(`SHELL=forge-shell`),
        out(`RUNTIME=browser`),
      ]),
  },
];

function sliceFile(
  args: string[],
  session: ShellSession,
  host: ShellHost,
  mode: 'head' | 'tail',
): ShellResult {
  let count = 10;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') {
      count = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(count) || count <= 0) return fail([err(`${mode}: invalid line count`)]);
    } else positional.push(args[i]);
  }
  if (!positional[0]) return fail([err(`${mode}: missing file operand`)]);
  const path = resolve(session, positional[0]);
  const content = host.getFiles()[path];
  if (content === undefined) return fail([err(`${mode}: ${positional[0]}: no such file`)]);
  const lines = content.split('\n');
  const slice = mode === 'head' ? lines.slice(0, count) : lines.slice(-count);
  return ok(slice.map((line) => out(line)));
}

export function commandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

export async function execute(
  input: string,
  session: ShellSession,
  host: ShellHost,
): Promise<ShellResult> {
  const trimmed = input.trim();
  if (!trimmed) return ok([]);
  const tokens = tokenize(trimmed);
  const name = tokens[0];
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    return fail([
      err(`forge: command not found: ${name}`),
      info('Run "help" to see every command this shell actually implements.'),
    ]);
  }
  try {
    return await command.run(tokens.slice(1), session, host);
  } catch (error) {
    if (error instanceof VfsError) return fail([err(`${name}: ${error.message}`)]);
    return fail([err(`${name}: ${error instanceof Error ? error.message : String(error)}`)]);
  }
}
