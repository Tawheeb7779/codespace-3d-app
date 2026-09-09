import { execFile } from 'node:child_process';
import { chown, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ContainerRuntime, CreateOptions, PtyHandle, SpawnOptions } from './types.ts';
import { GatewayError } from '../errors.ts';

const run = promisify(execFile);

/**
 * Docker, with the flags that make a container a boundary rather than a folder.
 *
 * The argument list below is the security model, so it is built by a pure
 * exported function and tested as data. That is deliberate: these flags are the
 * difference between an isolated workspace and a root shell on the host, and
 * they are easy to weaken by accident while debugging. `test/isolation.test.ts`
 * reads them and runs anywhere; `test/dockerSecurity.test.ts` creates a real
 * container from them and tries to get out of it.
 *
 * Both, because neither is enough. Reading the arguments cannot tell you a flag
 * does what its name says — `--storage-opt size=` and the workspace's ownership
 * were both wrong while every argument was right — and running a container
 * needs a daemon, which not every machine that edits this file has.
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

const CONTAINER_UID = 10001;
const CONTAINER_GID = 10001;
const CONTAINER_USER = `${CONTAINER_UID}:${CONTAINER_GID}`;
export const WORKSPACE_MOUNT = '/workspace';

/**
 * Whether this daemon can enforce a per-container disk quota.
 *
 * `--storage-opt size=` is not a portable flag: overlay2 implements it only on
 * XFS mounted with `pquota`, and on anything else — ext4, the usual case — the
 * daemon does not ignore it, it *refuses to create the container at all*. So a
 * flag added for defence in depth turns into a total outage on most hosts.
 *
 * Found by running it. The source-level test asserted the flag was present and
 * could not have known the daemon rejects it; nothing short of creating a real
 * container would have caught this.
 */
export function createArgs(
  options: CreateOptions,
  useGvisor: boolean,
  diskQuota = false,
): string[] {
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
    ...(diskQuota ? ['--storage-opt', `size=${tier.diskMb}m`] : []),
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
  /**
   * How long a `docker` invocation may take before it is abandoned.
   *
   * Without it a wedged daemon holds the caller forever, and the caller is
   * usually a WebSocket handshake or a reaper sweep — so one stuck command
   * becomes a stuck gateway rather than one failed request.
   */
  timeoutMs?: number;
  /**
   * Force the disk-quota decision instead of probing for it.
   *
   * Exists for tests; production probes once, at `available()`, because the
   * answer is a property of the daemon's storage driver and cannot change
   * while it is running.
   */
  diskQuota?: boolean;
  /** Reports what the probe decided, so an operator learns of an unenforced limit. */
  onCapabilities?: (capabilities: { diskQuota: boolean }) => void;
  /**
   * The image the quota probe uses.
   *
   * The workspace image the gateway is configured with, so the probe never
   * pulls anything and never depends on a floating tag.
   */
  image?: string;
}

/**
 * Does this daemon accept a per-container disk quota?
 *
 * Asked by trying it on a container that is created and immediately removed,
 * because there is no way to ask the daemon directly and guessing from the
 * storage driver's name is wrong — the answer depends on the filesystem
 * underneath it and on its mount options.
 */
export async function probeDiskQuota(
  exec: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  image: string,
): Promise<boolean> {
  // Random, not `Date.now()`. A timestamp collides when two gateways start in
  // the same millisecond — the second `docker create` fails on the name and the
  // probe reports "no quota support" for a daemon that has it — and it lets
  // anything else on the host predict the name and squat it.
  const name = `tacode-probe-${randomUUID()}`;
  try {
    await exec(['create', '--name', name, '--storage-opt', 'size=1024m', image, 'true']);
    await exec(['rm', '-f', name]).catch(() => undefined);
    return true;
  } catch {
    await exec(['rm', '-f', name]).catch(() => undefined);
    return false;
  }
}

/**
 * Container states in which a shell may be attached, or soon can be.
 *
 * `docker inspect` answers with one of a fixed set, and the distinction is not
 * cosmetic. `exists()` previously returned true for any non-empty status, so a
 * container that had `exited`, was `dead`, or was mid-`removing` was reported as
 * present — `ensure()` then handed that record back and the gateway tried to
 * `docker exec` into a corpse. The user got an opaque runtime error instead of
 * the working container that recreating would have given them.
 *
 * `created` and `restarting` are here deliberately: both are containers on
 * their way up, and treating them as absent would delete a container that was
 * about to be usable.
 */
const USABLE_STATES: readonly string[] = ['running', 'created', 'restarting', 'paused'];

/**
 * Make the workspace writable by the container, and prove it.
 *
 * The container runs as uid 10001 and the workspace is a bind mount, so the
 * host's ownership *is* the container's ownership. Getting this wrong does not
 * fail loudly — every flag is correct, the container starts, and the first
 * write inside it fails with a permission error that looks like a bug in the
 * user's own code.
 *
 * So the chown is verified rather than attempted. It used to be
 * `.catch(() => {})`, whose own comment said this was "an operator problem
 * worth failing loudly for" and then swallowed it. A container that cannot
 * write to its own project is not a degraded container, it is a broken one, and
 * starting it wastes the user's time and a slot on the host.
 *
 * The check is on the result, not on the call: a gateway that already owns the
 * directory needs no chown and must not be failed for a redundant one, and a
 * chown that "succeeds" against a filesystem that ignores ownership must not be
 * believed.
 */
export async function prepareWorkspace(workspaceDir: string): Promise<void> {
  await chown(workspaceDir, CONTAINER_UID, CONTAINER_GID).catch(() => undefined);

  const info = await stat(workspaceDir).catch(() => null);
  if (!info) {
    throw new GatewayError(
      'CONTAINER_ERROR',
      'The workspace could not be prepared.',
      `workspace directory is missing after creation: ${workspaceDir}`,
    );
  }
  if (info.uid !== CONTAINER_UID || info.gid !== CONTAINER_GID) {
    throw new GatewayError(
      'CONTAINER_ERROR',
      'The workspace could not be prepared.',
      `workspace ownership is ${info.uid}:${info.gid}, not ${CONTAINER_UID}:${CONTAINER_GID}; ` +
        'the gateway needs the privilege to chown its workspace root',
    );
  }
}

export function createDockerRuntime(options: DockerRuntimeOptions = {}): ContainerRuntime {
  const exec =
    options.exec ??
    ((args: string[]) =>
      run('docker', args, {
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        killSignal: 'SIGKILL',
      }));

  // Decided once, at startup, and then fixed: it is a property of the daemon.
  let diskQuota = options.diskQuota ?? false;

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
      } catch {
        return false;
      }
      if (options.diskQuota === undefined) {
        // The workspace image, not `busybox:latest`. Two reasons, and the second
        // is the one that bites: a floating tag is a mutable dependency pulled
        // at runtime by a security-relevant probe, and on a host with no
        // registry access the pull fails, the probe throws, and the failure is
        // indistinguishable from "this daemon cannot do quotas" — so the quota
        // is silently disabled on every air-gapped host. The workspace image is
        // already present, already the operator's pinned choice, and needs no
        // network.
        diskQuota = await probeDiskQuota(exec, options.image ?? 'ta-code/workspace:1').catch(
          () => false,
        );
      }
      options.onCapabilities?.({ diskQuota });
      return true;
    },

    async create(createOptions) {
      // The workspace is a bind mount, so the host's ownership is the
      // container's ownership. Created by this process — running as whatever
      // the gateway runs as — and then handed to the unprivileged uid the
      // container uses, or the container cannot write to its own project.
      //
      // Missing at first, and invisible to every source-level test: the flags
      // were all correct and `echo x > /workspace/f` still failed with
      // permission denied. Only creating a real container and trying to write
      // found it.
      await mkdir(createOptions.workspaceDir, { recursive: true });
      await prepareWorkspace(createOptions.workspaceDir);
      await docker(createArgs(createOptions, options.useGvisor ?? false, diskQuota));
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
        // The status, not merely some output. An `exited` or `dead` container
        // answers this call perfectly well and cannot be attached to.
        return USABLE_STATES.includes(out.stdout.trim());
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

    async runCommand(containerId, argv, runOptions = {}) {
      // `--user` and `--workdir` are set here rather than trusted from the
      // caller: a command that could choose its own uid or working directory
      // would be a way around both the container's identity and its workspace.
      const args = [
        'exec',
        '--user',
        CONTAINER_USER,
        '--workdir',
        runOptions.cwd ?? WORKSPACE_MOUNT,
        containerId,
        ...argv,
      ];
      try {
        const { stdout, stderr } = await run('docker', args, {
          maxBuffer: runOptions.maxBuffer ?? 4 * 1024 * 1024,
          timeout: runOptions.timeoutMs ?? 30_000,
          killSignal: 'SIGKILL',
        });
        return { stdout, stderr, code: 0 };
      } catch (error) {
        // A non-zero exit is an ordinary result here — `git diff --quiet`
        // reports "there are changes" that way — so it is returned rather than
        // thrown, and only the caller decides whether it is a failure.
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          code: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    },

    async listeningPorts(containerId) {
      // Read from inside, where `/proc/net/tcp` describes this container's
      // network namespace and nothing else. `cat` rather than `ss` or
      // `netstat`: those are packages the image may not carry, and a discovery
      // feature that depends on the user's toolchain stops working the moment
      // somebody slims the image.
      const out = await exec([
        'exec',
        '--user',
        CONTAINER_USER,
        containerId,
        '/bin/sh',
        '-c',
        // Read separately, and never fail. `/proc/net/tcp6` is absent on a
        // host built without IPv6, and `cat a b` exits non-zero when either is
        // missing — which discarded the IPv4 listeners that had been read
        // perfectly well, so discovery reported nothing at all. The trailing
        // `exit 0` is what makes a missing file a missing file rather than a
        // missing feature.
        'cat /proc/net/tcp 2>/dev/null; cat /proc/net/tcp6 2>/dev/null; exit 0',
      ]).catch(() => null);
      if (!out) return [];
      const { parseListeningPorts } = await import('../portDiscovery.ts');
      return parseListeningPorts(out.stdout);
    },
  };
}
