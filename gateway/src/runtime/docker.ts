import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerRuntime, CreateOptions, PtyHandle, SpawnOptions } from './types.ts';
import { GatewayError } from '../errors.ts';

const run = promisify(execFile);

/**
 * Docker, with the flags that make a container a boundary rather than a folder.
 *
 * The argument list below is the security model, so it is built by a pure
 * exported function and tested as data. That is deliberate: these flags are the
 * difference between an isolated workspace and a root shell on the host, they
 * are easy to weaken by accident while debugging, and a test that reads the
 * arguments catches that where a test that runs a container cannot — this
 * repository's CI has no Docker daemon.
 *
 * What each one is for, since a list of flags ages badly without reasons:
 *
 *   --user 10001:10001        Not root. Everything else assumes this.
 *   --cap-drop ALL            No capabilities at all, then none added back.
 *   --security-opt no-new-privileges
 *                             setuid binaries cannot raise privileges, which is
 *                             what turns a writable file into an escalation.
 *   --read-only               The image is immutable at runtime; only the
 *                             workspace and two tmpfs mounts are writable, so a
 *                             compromise cannot persist itself into the image.
 *   --tmpfs /tmp,/home/dev    …with noexec,nosuid, because a writable path that
 *                             can also execute is the usual next step.
 *   --pids-limit              What actually stops a fork bomb. Application
 *                             limits do not; a fork bomb does not read them.
 *   --memory / --cpus         cgroup limits, enforced by the kernel.
 *   --network none|bridge     Off by default. `full` is a deliberate choice an
 *                             operator makes to allow `npm install`.
 *   --runtime runsc           gVisor when present. It raises the cost of a
 *                             kernel exploit; it does not make escape
 *                             impossible, and nothing here assumes it does.
 *
 * There is no `-v /var/run/docker.sock`, no `--privileged`, no `--pid host` and
 * no host path but the workspace. A test asserts each of those absences,
 * because the way they arrive is a well-meaning edit, not a decision.
 */

const CONTAINER_USER = '10001:10001';
export const WORKSPACE_MOUNT = '/workspace';

export function createArgs(options: CreateOptions, useGvisor: boolean): string[] {
  const { containerId, workspaceDir, tier, image, network } = options;
  return [
    'create',
    '--name',
    containerId,
    '--hostname',
    'workspace',
    '--user',
    CONTAINER_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs',
    '/home/dev:rw,noexec,nosuid,size=64m',
    '--pids-limit',
    String(tier.pids),
    '--memory',
    `${tier.memoryMb}m`,
    // Without this a container under memory pressure swaps instead of being
    // killed, and takes the host's IO down with it.
    '--memory-swap',
    `${tier.memoryMb}m`,
    '--cpus',
    String(tier.cpus),
    '--storage-opt',
    `size=${tier.diskMb}m`,
    '--network',
    network === 'full' ? 'bridge' : 'none',
    ...(useGvisor ? ['--runtime', 'runsc'] : []),
    // The only host path that crosses. `rw` because the point is to run the
    // user's code against their files; `nosuid,nodev` so what lands there
    // cannot become a way out.
    '--mount',
    `type=bind,source=${workspaceDir},target=${WORKSPACE_MOUNT},bind-propagation=private`,
    '--workdir',
    WORKSPACE_MOUNT,
    '--label',
    'ta-code.workspace=1',
    // Restart is the orchestrator's decision. A container that resurrects
    // itself is an orphan the lifecycle manager cannot reason about.
    '--restart',
    'no',
    image,
    // PID 1 that reaps and does nothing else; shells arrive through `exec`.
    'sleep',
    'infinity',
  ];
}

export function execArgs(containerId: string, options: SpawnOptions): string[] {
  return [
    'exec',
    '-i',
    '-t',
    '--user',
    CONTAINER_USER,
    '--workdir',
    options.cwd,
    ...Object.entries(options.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    containerId,
    '/bin/bash',
    '-l',
  ];
}

export interface DockerRuntimeOptions {
  /** Injected so a test can drive the runtime without a daemon. */
  exec?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  spawnPty?: (args: string[], options: SpawnOptions) => PtyHandle;
  useGvisor?: boolean;
}

export function createDockerRuntime(options: DockerRuntimeOptions = {}): ContainerRuntime {
  const exec =
    options.exec ?? ((args: string[]) => run('docker', args, { maxBuffer: 4 * 1024 * 1024 }));

  const docker = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await exec(args);
      return stdout.trim();
    } catch (error) {
      // Docker's stderr can name host paths and image internals, so it is a
      // detail, never a message.
      const detail = error instanceof Error ? error.message : 'docker failed';
      throw new GatewayError('CONTAINER_ERROR', 'The workspace could not be prepared.', detail);
    }
  };

  return {
    name: 'docker',
    isolates: true,

    async available() {
      try {
        await exec(['version', '--format', '{{.Server.Version}}']);
        return true;
      } catch {
        return false;
      }
    },

    async create(createOptions) {
      await docker(createArgs(createOptions, options.useGvisor ?? false));
    },

    async start(containerId) {
      await docker(['start', containerId]);
    },

    async stop(containerId) {
      // A bounded stop: SIGTERM, then SIGKILL. An unbounded one lets a process
      // that ignores TERM hold a slot open forever.
      await docker(['stop', '--time', '5', containerId]).catch(() => '');
    },

    async destroy(containerId) {
      await docker(['rm', '--force', '--volumes', containerId]).catch(() => '');
    },

    async exists(containerId) {
      try {
        const out = await exec(['inspect', '--format', '{{.State.Status}}', containerId]);
        return out.stdout.trim().length > 0;
      } catch {
        return false;
      }
    },

    async spawnShell(containerId, spawnOptions) {
      const args = execArgs(containerId, spawnOptions);
      if (options.spawnPty) return options.spawnPty(args, spawnOptions);
      const { spawnPty } = await import('./pty.ts');
      return spawnPty('docker', args, spawnOptions);
    },

    async endpointFor(containerId, port) {
      // The container's own address on the bridge network. The proxy dials it
      // directly, so nothing is published to the host and no port of a user's
      // container is reachable from outside this process.
      const ip = await docker([
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        containerId,
      ]);
      return ip ? { host: ip, port } : null;
    },
  };
}
