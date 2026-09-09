import type { PtyHandle, SpawnOptions } from './types.ts';

/**
 * The one place a PTY is created.
 *
 * `node-pty` is loaded lazily and through a variable specifier so that
 * importing the gateway does not require the native module to have been built —
 * the protocol, auth, sync and path suites all run without it, which is what
 * keeps them runnable everywhere.
 *
 * Real PTY rather than pipes, and that is not a detail. A pipe gives no
 * terminal to the process, so `bash` starts non-interactive, Ctrl+C has nothing
 * to deliver a signal to, `npm` and `vite` disable colour and progress, and
 * anything that calls `isatty` behaves differently from how it behaves for a
 * user. A shell on a pipe is a demo of a shell.
 */

type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  };
};

let cached: PtyModule | null = null;

export async function loadPty(): Promise<PtyModule> {
  if (cached) return cached;
  const specifier = 'node-pty';
  cached = (await import(/* @vite-ignore */ specifier)) as unknown as PtyModule;
  return cached;
}

const SIGNAL_NUMBERS: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  9: 'SIGKILL',
  15: 'SIGTERM',
};

export function spawnPty(file: string, args: string[], options: SpawnOptions): PtyHandle {
  if (!cached) {
    throw new Error('loadPty() must be awaited before spawning');
  }
  const pty = cached.spawn(file, args, {
    // `xterm-color` rather than `xterm-256color`: the browser side is xterm.js,
    // and claiming a terminfo the front end does not fully implement produces
    // escape sequences it renders as text.
    name: 'xterm-color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });

  return {
    get pid() {
      return pty.pid;
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: (signal) => pty.kill(signal),
    onData: (listener) => pty.onData(listener),
    onExit: (listener) =>
      pty.onExit(({ exitCode, signal }) =>
        listener({
          exitCode: exitCode ?? null,
          signal: signal ? (SIGNAL_NUMBERS[signal] ?? `SIG${signal}`) : null,
        }),
      ),
  };
}
