import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ContainerRuntime, CreateOptions, PtyHandle, SpawnOptions } from './types.ts';
import { loadPty, spawnPty } from './pty.ts';

/**
 * A runtime with no isolation, for development and for tests.
 *
 * It runs the shell as an ordinary child process of the gateway, in a workspace
 * directory, with the same PTY plumbing the Docker runtime uses. That makes the
 * layers above it — the protocol, session lifecycle, reconnect and replay,
 * signals, exit codes, the file watcher, the sync engine and the port proxy —
 * testable on a machine with no container daemon, which is the only reason it
 * exists.
 *
 * `isolates` is false and the server refuses to start with it in production.
 * That is the whole safety story, and it is deliberately not softened: a
 * process here shares the host's filesystem, network and user. It is not a
 * weaker sandbox, it is no sandbox. Anything written to make this "a bit safer"
 * would be worse than useless, because it would invite someone to trust it.
 */

const run = promisify(execFile);

export function createLocalRuntime(): ContainerRuntime {
  const known = new Map<string, { workspaceDir: string; running: boolean }>();

  /** The directory this container was created with, and nothing else. */
  const workspaceFor = (containerId: string): string | undefined =>
    known.get(containerId)?.workspaceDir;

  return {
    name: 'local',
    isolates: false,

    async available() {
      try {
        await loadPty();
        return true;
      } catch {
        return false;
      }
    },

    async create(options: CreateOptions) {
      await mkdir(options.workspaceDir, { recursive: true });
      known.set(options.containerId, { workspaceDir: options.workspaceDir, running: false });
    },

    async start(containerId) {
      const entry = known.get(containerId);
      if (entry) entry.running = true;
    },

    async stop(containerId) {
      const entry = known.get(containerId);
      if (entry) entry.running = false;
    },

    async destroy(containerId) {
      const entry = known.get(containerId);
      known.delete(containerId);
      if (entry) await rm(entry.workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    },

    async exists(containerId) {
      return known.has(containerId);
    },

    async spawnShell(containerId, options: SpawnOptions): Promise<PtyHandle> {
      const entry = known.get(containerId);
      if (!entry) throw new Error(`unknown container ${containerId}`);
      await loadPty();
      return spawnPty('/bin/bash', ['--noprofile', '--norc', '-i'], {
        ...options,
        cwd: entry.workspaceDir,
        env: {
          ...options.env,
          // A prompt that says which environment this is, because the whole
          // point of the feature is that a user can tell the two apart.
          PS1: 'ta-code:\\w$ ',
          TERM: 'xterm-color',
        },
      });
    },

    async endpointFor(_containerId, port) {
      return { host: '127.0.0.1', port };
    },

    /**
     * Nothing, deliberately.
     *
     * This runtime shares the host's network namespace, so `/proc/net/tcp`
     * here lists every listener on the developer's machine — their database,
     * their other projects, whatever else is running. Reporting those as the
     * workspace's ports would be false, and offering them as preview links
     * would proxy a developer's unrelated services through the gateway.
     *
     * So port discovery is a property this runtime does not have, and says so.
     * The proxy still works for a port typed by hand, which is the behaviour
     * local development had before discovery existed.
     */
    async listeningPorts() {
      return [];
    },

    /**
     * The same contract as the Docker runtime, on the host's own filesystem.
     *
     * `execFile` and never a shell, so the argument vector stays a vector.
     * `cwd` is the workspace directory the caller was given, which is derived
     * from the container id rather than from anything a client sent.
     */
    async runCommand(containerId, argv, runOptions = {}) {
      const [command, ...rest] = argv;
      if (!command) return { stdout: '', stderr: 'no command', code: 1 };
      try {
        const { stdout, stderr } = await run(command, rest, {
          cwd: runOptions.cwd ?? workspaceFor(containerId),
          maxBuffer: runOptions.maxBuffer ?? 4 * 1024 * 1024,
          timeout: runOptions.timeoutMs ?? 30_000,
          killSignal: 'SIGKILL',
        });
        return { stdout, stderr, code: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          code: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    },
  };
}
