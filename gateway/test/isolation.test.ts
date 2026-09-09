import { describe, expect, it, vi } from 'vitest';
import { createArgs, createDockerRuntime, execArgs } from '../src/runtime/docker.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { configProblems, loadConfig } from '../src/config.ts';

/**
 * The container's isolation, tested as the arguments that produce it.
 *
 * This is not a substitute for running a container and trying to escape it, and
 * it is not presented as one. `dockerSecurity.test.ts` does that, against a
 * real daemon, and is where the isolation claims are actually established; this
 * suite runs everywhere, needs nothing, and catches the failure that actually
 * happens in practice, which is not a novel kernel exploit. It is somebody
 * adding `--privileged` to debug a permissions problem on a Friday, or mounting
 * the Docker socket because a tool asked for it, and nobody noticing.
 *
 * The two are complementary in a way worth stating, because it is the lesson of
 * this phase: reading the arguments cannot tell you a flag does what its name
 * says. Every flag below was correct while the workspace was unwritable and the
 * daemon refused the container outright.
 *
 * Each assertion below is a flag whose absence or presence is the difference
 * between a workspace and a root shell on the host, so each is asserted by
 * name.
 */

const tier = loadConfig({}).tiers.free;
const options = {
  containerId: 'tacode-abc123',
  workspaceDir: '/var/lib/ta-code/workspaces/tacode-abc123',
  tier,
  image: 'ta-code/workspace:1',
  network: 'none' as const,
};

const argsFor = (overrides = {}, gvisor = false) =>
  createArgs({ ...options, ...overrides }, gvisor);

/** `--flag value` as a pair, so an assertion reads like the command line. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('what a workspace container may do', () => {
  it('does not run as root', () => {
    expect(valueOf(argsFor(), '--user')).toBe('10001:10001');
  });

  it('holds no capabilities', () => {
    expect(valueOf(argsFor(), '--cap-drop')).toBe('ALL');
    // Nothing is added back. `--cap-add` appearing here at all is the bug.
    expect(argsFor()).not.toContain('--cap-add');
  });

  it('cannot gain privileges through a setuid binary', () => {
    expect(valueOf(argsFor(), '--security-opt')).toBe('no-new-privileges');
  });

  it('cannot write to its own image', () => {
    expect(argsFor()).toContain('--read-only');
  });

  it('gets writable scratch space that cannot execute', () => {
    const tmpfs = argsFor().filter((_, index, all) => all[index - 1] === '--tmpfs');
    expect(tmpfs.length).toBeGreaterThan(0);
    for (const mount of tmpfs) {
      expect(mount, mount).toContain('noexec');
      expect(mount, mount).toContain('nosuid');
      expect(mount, mount).toMatch(/size=\d+m/);
    }
  });
});

describe('what a workspace container cannot reach', () => {
  const args = argsFor();
  const joined = args.join(' ');

  /**
   * The single most dangerous mount there is: it is a root shell on the host,
   * one `docker run -v /:/host` away.
   */
  it('never mounts the Docker socket', () => {
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('/var/run/docker');
  });

  it('is never privileged, and never shares the host’s namespaces', () => {
    for (const flag of ['--privileged', '--pid', '--ipc', '--userns', '--net=host']) {
      expect(args, flag).not.toContain(flag);
    }
    // The dangerous spellings specifically. A blanket search for "host" would
    // match `--hostname workspace`, which is the container's own name and is
    // there so a prompt does not show a random hex id.
    expect(joined).not.toMatch(/(--network|--net)[= ]host\b/);
    expect(joined).not.toMatch(/--(pid|ipc|uts|userns)[= ]host\b/);
  });

  it('mounts exactly one host path: its own workspace', () => {
    const mounts = args.filter((_, index) => args[index - 1] === '--mount' || args[index - 1] === '-v');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain(`source=${options.workspaceDir}`);
    expect(mounts[0]).toContain('target=/workspace');
  });

  it('cannot mount another workspace by construction', () => {
    const mine = argsFor({ containerId: 'tacode-aaa', workspaceDir: '/ws/tacode-aaa' });
    expect(mine.join(' ')).toContain('source=/ws/tacode-aaa');
    expect(mine.join(' ')).not.toContain('/ws/tacode-bbb');
  });

  it('has no network unless an operator asks for one', () => {
    expect(valueOf(argsFor(), '--network')).toBe('none');
    expect(valueOf(argsFor({ network: 'full' }), '--network')).toBe('bridge');
    // Never the host's network stack, which would reach every internal service.
    expect(valueOf(argsFor({ network: 'full' }), '--network')).not.toBe('host');
  });

  /**
   * The gateway holds a Supabase service-role key and users' tokens. None of it
   * may be in a container's environment, which every process inside can read.
   */
  it('carries none of the gateway’s own secrets into the container', () => {
    const shell = execArgs('tacode-abc123', {
      cwd: '/workspace',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-color', HOME: '/home/dev', TA_CODE: '1', PATH: '/usr/bin' },
    });
    const joined = shell.join(' ');

    for (const forbidden of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'GEMINI_API_KEY',
      'GITHUB_TOKEN',
      'GITHUB_CLIENT_SECRET',
      'access_token',
    ]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
  });

  it('runs the shell as the unprivileged user too, not as root', () => {
    const shell = execArgs('c1', { cwd: '/workspace', cols: 80, rows: 24, env: {} });
    expect(valueOf(shell, '--user')).toBe('10001:10001');
  });
});

describe('resource ceilings', () => {
  it('caps processes, which is what stops a fork bomb', () => {
    expect(valueOf(argsFor(), '--pids-limit')).toBe(String(tier.pids));
  });

  it('caps memory, and does not let it spill into swap', () => {
    expect(valueOf(argsFor(), '--memory')).toBe(`${tier.memoryMb}m`);
    // Equal to --memory: without this the container swaps instead of being
    // killed, and takes the host's IO down with it.
    expect(valueOf(argsFor(), '--memory-swap')).toBe(`${tier.memoryMb}m`);
  });

  it('caps CPU', () => {
    expect(valueOf(argsFor(), '--cpus')).toBe(String(tier.cpus));
  });

  /**
   * The disk cap is the one limit that is conditional, and the condition is the
   * daemon's, not a preference: overlay2 implements `--storage-opt size=` only
   * on XFS with `pquota`, and elsewhere it does not ignore the flag — it
   * refuses to create the container. Sending it unconditionally is not a
   * stricter container, it is no container at all.
   *
   * Only running one found that. This asserts both halves of the decision so
   * the flag cannot quietly become unconditional again.
   */
  it('caps disk where the daemon can enforce it, and omits the flag where it cannot', () => {
    const supported = createArgs(options, false, true);
    const unsupported = createArgs(options, false, false);

    expect(valueOf(supported, '--storage-opt')).toBe(`size=${tier.diskMb}m`);
    expect(unsupported).not.toContain('--storage-opt');
  });

  it('applies a bigger tier when one is configured', () => {
    const pro = loadConfig({}).tiers.pro;
    const args = argsFor({ tier: pro });

    expect(valueOf(args, '--memory')).toBe(`${pro.memoryMb}m`);
    expect(valueOf(args, '--pids-limit')).toBe(String(pro.pids));
  });

  it('reads limits from the environment, so they are tunable without a deploy', () => {
    const config = loadConfig({ TACODE_FREE_MEMORY_MB: '256', TACODE_FREE_PIDS: '64' });

    expect(config.tiers.free.memoryMb).toBe(256);
    expect(config.tiers.free.pids).toBe(64);
  });

  it('never restarts a container behind the orchestrator’s back', () => {
    expect(valueOf(argsFor(), '--restart')).toBe('no');
  });
});

describe('gVisor', () => {
  it('is used when the deployment has it', () => {
    expect(valueOf(argsFor({}, true), '--runtime')).toBe('runsc');
  });

  /**
   * And nothing else changes when it is on. gVisor raises the cost of a kernel
   * exploit; it is not a reason to drop a capability check, and this asserts
   * that none of them were made conditional on it.
   */
  it('does not relax any other restriction', () => {
    const withGvisor = argsFor({}, true);
    expect(withGvisor).toContain('--read-only');
    expect(valueOf(withGvisor, '--cap-drop')).toBe('ALL');
    expect(valueOf(withGvisor, '--user')).toBe('10001:10001');
    expect(valueOf(withGvisor, '--pids-limit')).toBe(String(tier.pids));
  });
});

describe('the runtimes describe themselves honestly', () => {
  it('says which one isolates and which does not', () => {
    expect(createDockerRuntime({ exec: async () => ({ stdout: '', stderr: '' }) }).isolates).toBe(true);
    expect(createLocalRuntime().isolates).toBe(false);
  });

  /**
   * The check that keeps the development runtime out of production. It is a
   * property the code reads, not a warning in a README.
   */
  it('refuses the non-isolating runtime in production configuration', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const problems = configProblems(
        loadConfig({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k', TACODE_RUNTIME: 'local' }),
      );
      expect(problems.join(' ')).toMatch(/no isolation/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('will not start without a way to authenticate anybody', () => {
    expect(configProblemsFor({})).toMatch(/SUPABASE_URL/);
    expect(configProblemsFor({ SUPABASE_URL: 'https://x' })).toMatch(/SERVICE_ROLE/);
  });
});

function configProblemsFor(env: NodeJS.ProcessEnv): string {
  return configProblems(loadConfig(env)).join(' ');
}

describe('docker failures do not leak host detail', () => {
  it('replaces docker’s stderr with something safe to show a user', async () => {
    const runtime = createDockerRuntime({
      exec: vi.fn(async () => {
        throw new Error('docker: /var/lib/docker/overlay2/abc: permission denied for root');
      }),
    });

    await expect(runtime.create(options)).rejects.toMatchObject({
      code: 'CONTAINER_ERROR',
      message: 'The workspace could not be prepared.',
    });
  });
});
