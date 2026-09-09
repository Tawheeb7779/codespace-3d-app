import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createArgs, createDockerRuntime, execArgs, probeDiskQuota } from '../src/runtime/docker.ts';
import { loadConfig } from '../src/config.ts';

const run = promisify(execFile);

/**
 * Container isolation, executed rather than asserted.
 *
 * `isolation.test.ts` reads the arguments; this creates a real container from
 * those same arguments on a real daemon and tries to get out of it. The two are
 * not redundant: the argument test catches a flag being removed, and this
 * catches a flag that is present and does not do what the name suggests — which
 * is how `--storage-opt size=` was discovered to make the daemon refuse the
 * container outright on any filesystem but XFS.
 *
 *   TACODE_DOCKER_TESTS=1 npx vitest run test/dockerSecurity.test.ts
 *
 * Skipped by default, and skipped loudly rather than passing vacuously: a
 * security suite that silently reports success on a machine with no daemon is
 * worse than no suite, because somebody will read the green tick.
 *
 * Everything here is non-destructive. Nothing attacks the host: the tests ask
 * the container what it can see and try to touch things *inside their own
 * confinement*, and the two resource tests are bounded — a process cap probed
 * with a counted loop, memory with a single bounded allocation that the kernel
 * kills. There is no fork bomb.
 */

const ENABLED = process.env.TACODE_DOCKER_TESTS === '1';
const IMAGE = process.env.TACODE_TEST_IMAGE ?? 'ta-code/workspace-test:1';
const WORKSPACE = '/var/lib/ta-code-test/security';
const NAME = 'tacode-sec-probe';

const tier = { ...loadConfig({}).tiers.free, pids: 64, memoryMb: 256 };

/** Run a command inside the container, exactly as the gateway's shell would. */
async function inside(command: string): Promise<{ out: string; code: number }> {
  const args = execArgs(NAME, {
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/dev' },
  })
    // `-t` allocates a TTY, which a captured exec neither has nor needs.
    .filter((arg) => arg !== '-t')
    // Replace the interactive login shell with the command under test.
    .slice(0, -2)
    .concat(['/bin/bash', '-c', command]);

  try {
    const { stdout, stderr } = await run('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { out: `${stdout}${stderr}`.trim(), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim(), code: failure.code ?? 1 };
  }
}

/** The same, against a container other than the shared one. */
async function insideOf(container: string, command: string): Promise<{ out: string; code: number }> {
  const args = execArgs(container, {
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/dev' },
  })
    .filter((arg) => arg !== '-t')
    .slice(0, -2)
    .concat(['/bin/bash', '-c', command]);

  try {
    const { stdout, stderr } = await run('docker', args, { maxBuffer: 8 * 1024 * 1024 });
    return { out: `${stdout}${stderr}`.trim(), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim(), code: failure.code ?? 1 };
  }
}

/**
 * A disposable container for a test that spends a resource.
 *
 * Two of the limit tests deliberately exhaust something, and a container whose
 * memory cgroup or process table is full stays full: every later `docker exec`
 * into it is SIGKILLed before it runs, and reports as an empty-output failure
 * of a test that has nothing to do with the limit. That is not hypothetical —
 * it is how the memory test came to be blamed for breaking the network tests.
 */
async function withProbe(
  suffix: string,
  overrides: Partial<typeof tier>,
  body: (container: string) => Promise<void>,
): Promise<void> {
  const container = `${NAME}-${suffix}`;
  const workspace = `${WORKSPACE}-${suffix}`;
  const runtime = createDockerRuntime({ diskQuota: false });
  await run('docker', ['rm', '-f', container]).catch(() => undefined);
  await runtime.create({
    containerId: container,
    workspaceDir: workspace,
    tier: { ...tier, ...overrides },
    image: IMAGE,
    network: 'none',
  });
  await runtime.start(container);
  try {
    await body(container);
  } finally {
    await run('docker', ['rm', '-f', container]).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A cgroup limit as the kernel holds it, read from inside the container.
 *
 * Stronger evidence than `docker inspect`, which reports what the daemon was
 * asked for rather than what is being enforced. Both cgroup layouts are tried
 * because v1 and v2 hosts spell the same limit differently.
 */
async function cgroupLimit(container: string, v1: string, v2: string): Promise<string> {
  const { out } = await insideOf(container, `cat /sys/fs/cgroup/${v2} 2>/dev/null || cat /sys/fs/cgroup/${v1} 2>/dev/null`);
  return out.trim();
}

const inspect = async (format: string): Promise<string> => {
  const { stdout } = await run('docker', ['inspect', '--format', format, NAME]);
  return stdout.trim();
};

let available = false;

beforeAll(async () => {
  if (!ENABLED) return;
  await run('docker', ['version'], { timeout: 15_000 });

  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(`${WORKSPACE}/project-file.txt`, 'belongs to the project\n');

  await run('docker', ['rm', '-f', NAME]).catch(() => undefined);

  // The gateway's own arguments, with the disk quota decided the way the
  // gateway decides it at startup.
  const diskQuota = await probeDiskQuota(
    (args) => run('docker', args) as Promise<{ stdout: string; stderr: string }>,
    IMAGE,
  );
  void createArgs; // referenced by the argument suite; used here via the runtime

  // Through the runtime's own `create`, so what is under test is the code path
  // the gateway takes — including the workspace ownership it has to set up.
  const runtime = createDockerRuntime({ diskQuota });
  await runtime.create({
    containerId: NAME,
    workspaceDir: WORKSPACE,
    tier,
    image: IMAGE,
    network: 'none',
  });
  await runtime.start(NAME);
  available = true;
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
});

const test = ENABLED ? it : it.skip;

describe.skipIf(!ENABLED)('a real container, on a real daemon', () => {
  test('starts at all, which is the thing an argument test cannot prove', () => {
    expect(available).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  test('sec01 — runs as an unprivileged user, not root', async () => {
    const { out } = await inside('id -u; id -g');

    const [uid, gid] = out.split('\n');
    expect(uid.trim()).toBe('10001');
    expect(gid.trim()).toBe('10001');
  });

  test('sec02 — cannot become root', async () => {
    // No setuid path is expected to exist, and `no-new-privileges` means one
    // would not help. Both spellings are tried.
    const su = await inside('su root -c id 2>&1 || true');
    const sudo = await inside('sudo id 2>&1 || true');

    expect(su.out).not.toMatch(/uid=0\(root\)/);
    expect(sudo.out).not.toMatch(/uid=0\(root\)/);
  });

  // -------------------------------------------------------------------------
  // Capabilities and escalation
  // -------------------------------------------------------------------------

  test('sec03 — holds no effective capabilities', async () => {
    const { out } = await inside('grep -E "^CapEff|^CapPrm|^CapBnd" /proc/self/status');

    // All zero. Anything else means a capability survived `--cap-drop ALL`.
    for (const line of out.split('\n')) {
      expect(line.trim(), line).toMatch(/^Cap(Eff|Prm|Bnd):\s+0000000000000000$/);
    }
  });

  test('sec04 — no-new-privileges is set on the process', async () => {
    const { out } = await inside('grep NoNewPrivs /proc/self/status');

    expect(out).toMatch(/NoNewPrivs:\s+1/);
  });

  test('sec05 — cannot mount anything, which is the usual escape primitive', async () => {
    const { out, code } = await inside('mount -t proc proc /tmp 2>&1; echo "rc=$?"');

    expect(code === 0 ? out : out).toMatch(/rc=[1-9]|denied|not permitted|must be superuser/i);
  });

  // -------------------------------------------------------------------------
  // Filesystem confinement
  // -------------------------------------------------------------------------

  test('sec06 — sees the workspace, and only the workspace, of the host', async () => {
    const { out } = await inside('cat /workspace/project-file.txt');

    expect(out).toContain('belongs to the project');
  });

  test('sec07 — cannot read the host filesystem outside the workspace', async () => {
    // These exist on the host and must not be reachable *as the host's*.
    const shadow = await inside('cat /etc/shadow 2>&1; echo rc=$?');
    const hostMarker = await inside('cat /var/lib/ta-code-test/security/project-file.txt 2>&1; echo rc=$?');

    expect(shadow.out).toMatch(/rc=[1-9]|No such file|denied/i);
    // The host path is not the container path: the bind is at /workspace only.
    expect(hostMarker.out).toMatch(/rc=[1-9]|No such file/i);
  });

  test('sec08 — cannot traverse out of the workspace', async () => {
    const { out } = await inside('cat /workspace/../../../etc/shadow 2>&1; echo rc=$?');

    expect(out).toMatch(/rc=[1-9]|No such file|denied/i);
  });

  test('sec09 — cannot write outside the workspace: the root filesystem is read-only', async () => {
    for (const path of ['/usr/bin/evil', '/etc/evil', '/opt/evil', '/evil']) {
      const { out } = await inside(`touch ${path} 2>&1; echo rc=$?`);
      expect(out, path).toMatch(/rc=[1-9]|Read-only file system|denied/i);
    }
  });

  test('sec10 — can write inside the workspace, because that is the point', async () => {
    const { out } = await inside('echo written-by-container > /workspace/from-container.txt && cat /workspace/from-container.txt');

    expect(out).toContain('written-by-container');
  });

  test('sec11 — scratch space is writable but cannot execute', async () => {
    const write = await inside('echo ok > /tmp/scratch && cat /tmp/scratch');
    expect(write.out).toContain('ok');

    // A writable path that can also execute is the usual next step after a
    // download; `noexec` is what stops it.
    const exec = await inside(
      'printf "#!/bin/bash\\necho RAN\\n" > /tmp/x.sh && chmod +x /tmp/x.sh && /tmp/x.sh 2>&1; echo rc=$?',
    );
    expect(exec.out).not.toContain('RAN');
    expect(exec.out).toMatch(/rc=[1-9]|Permission denied/i);
  });

  // -------------------------------------------------------------------------
  // The host's own control plane
  // -------------------------------------------------------------------------

  test('sec12 — has no Docker socket, the single most dangerous mount', async () => {
    for (const path of ['/var/run/docker.sock', '/run/docker.sock', '/dev/docker.sock']) {
      const { out } = await inside(`test -S ${path} && echo PRESENT || echo absent`);
      expect(out, path).toContain('absent');
    }
  });

  test('sec13 — cannot see the host’s processes', async () => {
    const { out } = await inside('ls /proc | grep -cE "^[0-9]+$"');

    // A container sharing the host's PID namespace sees hundreds of processes;
    // its own namespace has a handful.
    expect(Number(out.trim())).toBeLessThan(20);
  });

  test('sec14 — is in its own PID, mount, IPC, UTS and network namespaces', async () => {
    const container = await inside('readlink /proc/self/ns/pid /proc/self/ns/mnt /proc/self/ns/ipc /proc/self/ns/uts /proc/self/ns/net');
    const { stdout: host } = await run('readlink', [
      '/proc/self/ns/pid',
      '/proc/self/ns/mnt',
      '/proc/self/ns/ipc',
      '/proc/self/ns/uts',
      '/proc/self/ns/net',
    ]);

    const containerNs = container.out.split('\n').map((line) => line.trim()).filter(Boolean);
    const hostNs = host.split('\n').map((line) => line.trim()).filter(Boolean);

    expect(containerNs).toHaveLength(5);
    for (const ns of containerNs) {
      expect(hostNs, `namespace shared with the host: ${ns}`).not.toContain(ns);
    }
  });

  test('sec15 — the container is not privileged, by the daemon’s own account', async () => {
    expect(await inspect('{{.HostConfig.Privileged}}')).toBe('false');
    expect(await inspect('{{.HostConfig.PidMode}}')).toBe('');
    expect(await inspect('{{.HostConfig.IpcMode}}')).not.toBe('host');
    expect(await inspect('{{.HostConfig.NetworkMode}}')).not.toBe('host');
    expect(await inspect('{{.HostConfig.UTSMode}}')).toBe('');
  });

  test('sec16 — exactly one host path is bound, and it is the workspace', async () => {
    const mounts = await inspect('{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}');
    const binds = mounts.split(' ').filter((entry) => entry.startsWith('bind:'));

    expect(binds).toHaveLength(1);
    expect(binds[0]).toBe(`bind:${WORKSPACE}->/workspace`);
  });

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  test('sec17 — carries none of the gateway’s credentials in its environment', async () => {
    const { out } = await inside('env');

    for (const forbidden of [
      'SUPABASE',
      'SERVICE_ROLE',
      'GEMINI',
      'GITHUB_TOKEN',
      'GITHUB_CLIENT',
      'access_token',
      'AWS_',
    ]) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });

  test('sec18 — cannot read the gateway’s own environment through /proc', async () => {
    // PID 1 in the container is `sleep`, not the gateway; the host's processes
    // are not in this namespace at all.
    const { out } = await inside('cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | head -20');

    expect(out).not.toMatch(/SUPABASE|SERVICE_ROLE|GEMINI|GITHUB/);
  });

  // -------------------------------------------------------------------------
  // Resource limits
  // -------------------------------------------------------------------------

  /**
   * In a container of its own, and this matters.
   *
   * The first version ran here and left sixty-four sleeping processes behind,
   * so every test after it failed with `fork: Resource temporarily
   * unavailable` — the limit working exactly as intended, reported as four
   * unrelated failures. A test that exhausts a resource cannot share a
   * container with tests that need it.
   */
  test('sec19 — the process limit is real, and is reached in a controlled way', async () => {
    await withProbe('pids', { pids: 32 }, async (probe) => {
      // The limit as the kernel holds it, before anything tries to exceed it.
      expect(await cgroupLimit(probe, 'pids/pids.max', 'pids.max')).toBe('32');

      // Bounded on purpose: a counted loop that stops, with short-lived
      // children, not a fork bomb. It asks "does the limit exist", not "can I
      // take the host down".
      //
      // A brace range, not `$(seq …)`: `seq` is a separate binary, and on an
      // image without it the substitution is empty, the loop body never runs,
      // and the test reports `started=0 refused=0` — a limit that was working
      // perfectly, read as a failure.
      const { out } = await insideOf(
        probe,
        'ok=0; fail=0; for i in {1..120}; do if sleep 2 & then ok=$((ok+1)); else fail=$((fail+1)); fi; done; echo "started=$ok refused=$fail"',
      );

      // Either the shell reported refusals, or the kernel refused the forks
      // loudly. Both are the limit doing its job; neither is "120 succeeded".
      // Its complaints go to stderr, so they are captured, not discarded — an
      // earlier `2>/dev/null` here threw away the only evidence there was.
      expect(out).toMatch(/refused=[1-9]|Resource temporarily unavailable|fork: retry/i);
      expect(out).not.toMatch(/started=120 refused=0/);
    });
  }, 120_000);

  /**
   * Also in a container of its own, for a reason worth stating: the balloon is
   * written to a tmpfs, tmpfs pages are charged to the container's memory
   * cgroup, and the shell is killed before it reaches the `rm`. The pages stay
   * charged, so the container is at its limit forever after and every later
   * `exec` into it dies at 137 with no output.
   */
  test('sec20 — the memory limit is enforced by the kernel', async () => {
    expect(await inspect('{{.HostConfig.Memory}}')).toBe(String(tier.memoryMb * 1024 * 1024));
    // Equal to Memory: without it the container swaps rather than being killed.
    expect(await inspect('{{.HostConfig.MemorySwap}}')).toBe(String(tier.memoryMb * 1024 * 1024));

    await withProbe('memory', { memoryMb: 256 }, async (probe) => {
      // What the daemon was asked for is above; this is what is enforced.
      expect(await cgroupLimit(probe, 'memory/memory.limit_in_bytes', 'memory.max')).toBe(
        String(256 * 1024 * 1024),
      );

      // A single bounded allocation, far above the cap, which the kernel stops.
      // `dd` into a tmpfs is used rather than a program that allocates forever.
      const { out, code } = await insideOf(
        probe,
        'dd if=/dev/zero of=/tmp/balloon bs=1M count=400 2>&1; echo rc=$?',
      );

      // Two shapes of the same answer. `dd` may report the failure itself, or
      // the OOM killer may take the shell first — 137 is SIGKILL, and an empty
      // stream is what a process killed mid-write leaves behind. What must not
      // happen is a clean `rc=0`, which would mean 400MB was allocated under a
      // 256MB cap.
      const killed = code === 137;
      expect(killed || /rc=[1-9]|No space left|Killed|cannot allocate/i.test(out)).toBe(true);
      expect(out).not.toMatch(/\brc=0\b/);
    });
  }, 60_000);

  /**
   * `--cpus` is recorded as `NanoCpus`, not as a quota/period pair — the pair
   * is what `--cpu-quota` sets. Asserting the wrong field reported a limit of
   * zero on a container that was correctly limited.
   */
  test('sec21 — the CPU limit is recorded on the container', async () => {
    const nanoCpus = Number(await inspect('{{.HostConfig.NanoCpus}}'));

    expect(nanoCpus / 1e9).toBeCloseTo(tier.cpus, 2);
  });

  // -------------------------------------------------------------------------
  // Network policy
  // -------------------------------------------------------------------------

  test('sec22 — with network "none", the container has no route anywhere', async () => {
    expect(await inspect('{{.HostConfig.NetworkMode}}')).toBe('none');

    // No interface but loopback, so there is nothing to filter later.
    const { out } = await inside('ip -o link show 2>/dev/null | wc -l');
    expect(Number(out.trim())).toBeLessThanOrEqual(1);
  });

  test('sec23 — cannot reach the host, the gateway, or cloud metadata', async () => {
    for (const target of ['169.254.169.254', '127.0.0.1', '172.17.0.1']) {
      const { out } = await inside(
        `timeout 3 bash -c "echo > /dev/tcp/${target}/80" 2>&1; echo rc=$?`,
      );
      // 169.254.169.254 is the cloud metadata endpoint, which is the first
      // thing anything hostile in a container reaches for.
      expect(out, target).toMatch(/rc=[1-9]/);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Port discovery
//
// Reading `/proc/net/tcp` inside the container is only correct if that file
// really is namespaced, which is a property of the kernel this runs on and not
// something a fixture can establish.
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('discovering what a container is serving', () => {
  test('sec24 — reports a port the container is actually listening on', async () => {
    await withProbe('ports', {}, async (probe) => {
      const runtime = createDockerRuntime({ diskQuota: false });

      // Nothing is listening yet, and the answer must be that rather than a
      // list of the host's ports.
      expect(await runtime.listeningPorts(probe)).toEqual([]);

      // A real listener, in the container's own network namespace.
      await run('docker', [
        'exec',
        '-d',
        '--user',
        '10001:10001',
        probe,
        '/bin/sh',
        '-c',
        'nc -l -p 5173 -s 0.0.0.0 >/dev/null 2>&1',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(await runtime.listeningPorts(probe)).toContain(5173);
    });
  }, 120_000);

  /**
   * The property the whole feature rests on. If `/proc/net/tcp` were the
   * host's, every container would report the gateway's own listeners — and
   * offer them as preview links.
   */
  test('sec25 — cannot see the host’s listening ports', async () => {
    const listener = createServer(() => undefined);
    await new Promise<void>((resolve) => listener.listen(0, '0.0.0.0', resolve));
    const hostPort = (listener.address() as { port: number }).port;

    try {
      await withProbe('ports-isolation', {}, async (probe) => {
        const seen = await createDockerRuntime({ diskQuota: false }).listeningPorts(probe);

        expect(seen).not.toContain(hostPort);
        expect(seen).toEqual([]);
      });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The sync boundary, against a container that is actually trying to leave
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('a real container attacking its own workspace mount', () => {
  /**
   * The escape as the container would actually perform it.
   *
   * Nothing here is privileged: the container owns `/workspace`, so `ln -s`
   * needs no capability the security model grants it. Every isolation flag is
   * correct and irrelevant — the link is followed on the *host* side, by the
   * gateway, when the editor writes a file whose path crosses it.
   *
   * This is the end-to-end form of the unit regression in
   * `hardeningAudit.test.ts`, and it is here because a fixture cannot prove the
   * container can create the link in the first place.
   */
  test('sec26 — cannot make the gateway write outside the workspace', async () => {
    const { SyncIndex, applyEditorWrite, readContainerChange } = await import('../src/sync.ts');
    const { readFile, writeFile: write, mkdir: makeDir } = await import('node:fs/promises');

    await withProbe('symlink', {}, async (probe) => {
      const workspace = `${WORKSPACE}-symlink`;
      const outside = '/var/lib/ta-code-test/outside-symlink';
      await makeDir(outside, { recursive: true });
      await write(`${outside}/host-secret.txt`, 'HOST SECRET CONTENTS\n');

      // The container plants the link itself, with its own unprivileged shell.
      const planted = await insideOf(probe, `ln -s ${outside} /workspace/escape && ls -l /workspace`);
      expect(planted.out).toMatch(/escape/);

      const limits = { maxFileBytes: 1024 * 1024, maxFiles: 100 };

      // The editor writes a path that crosses the link. It must be refused.
      await expect(
        applyEditorWrite(
          workspace,
          new SyncIndex(),
          { path: 'escape/pwned.txt', content: 'written outside the workspace\n' },
          limits,
        ),
      ).rejects.toThrow();
      await expect(readFile(`${outside}/pwned.txt`, 'utf8')).rejects.toThrow();

      // And the other direction: a host file must not be read back for the browser.
      const leaked = await readContainerChange(
        workspace,
        new SyncIndex(),
        'escape/host-secret.txt',
        limits,
      );
      expect(leaked).toBeNull();

      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Kernel-level syscall filtering
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('the syscall filter the daemon applies', () => {
  /**
   * The runtime never passes `--security-opt seccomp=`, so the container gets
   * Docker's builtin profile. That is the intended posture, and it is worth an
   * assertion because the way it is lost is somebody adding
   * `seccomp=unconfined` to debug a syscall and leaving it there — after which
   * every flag still reads correctly and the kernel filter is simply gone.
   *
   * `Seccomp: 2` is SECCOMP_MODE_FILTER. `0` would mean no filter at all.
   */
  test('sec27 — a seccomp filter is loaded in the container', async () => {
    const { out } = await inside('grep -E "^Seccomp:|^Seccomp_filters:" /proc/self/status');

    expect(out).toMatch(/Seccomp:\s*2/);
    expect(out).toMatch(/Seccomp_filters:\s*[1-9]/);
  });

  /**
   * gVisor is not installed on this host, so `--runtime runsc` has never run.
   * This asserts what is actually true — the container is on the default
   * runtime — rather than leaving a reader to assume otherwise from the
   * presence of the flag in `createArgs`.
   */
  test('sec28 — records which runtime actually executed this container', async () => {
    const runtime = await inspect('{{.HostConfig.Runtime}}');

    // Whatever it is, it is reported rather than asserted to be gVisor. If a
    // host ever does have runsc, this is where that becomes visible.
    expect(runtime.length).toBeGreaterThan(0);
    if (runtime !== 'runsc') {
      expect(['runc', '', 'io.containerd.runc.v2']).toContain(runtime);
    }
  });
});
