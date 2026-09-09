import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerIdFor } from '../src/lifecycle.ts';
import { normalizePath, resolveInWorkspaceNoSymlinks, PathError } from '../src/workspace.ts';
import { SyncIndex, applyEditorWrite, readContainerChange, containerManifest } from '../src/sync.ts';
import { createDockerRuntime, probeDiskQuota, prepareWorkspace } from '../src/runtime/docker.ts';

/**
 * Regressions for an independent security audit.
 *
 * Each test here stands for a specific defect that was reachable at commit
 * fe9d68e, and each fails against the code as it was. They are grouped by the
 * finding they protect so that a future change that reintroduces one is
 * reported as the security regression it is rather than as a puzzling
 * assertion.
 */

const limits = { maxFileBytes: 1024 * 1024, maxFiles: 1000 };

async function workspace(): Promise<{ root: string; ws: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tacode-audit-'));
  const ws = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(ws, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, ws, outside };
}

// ---------------------------------------------------------------------------
// P0 — container identity
// ---------------------------------------------------------------------------

describe('the container id, which also names a directory', () => {
  /**
   * The vulnerability, stated as a test.
   *
   * The id was a 32-bit FNV-1a of `userId:projectId`, and it names the
   * workspace directory. Project ids are generated in the browser and POSTed,
   * so an attacker picks one half of the input: they grind offline for a
   * project id whose key collides with a victim's, create a project under it,
   * and their container bind-mounts the victim's workspace. A collision was
   * found in under three minutes of single-threaded JavaScript.
   *
   * These are the exact values that collided under the old hash.
   */
  it('does not collide for the pair that broke the previous hash', () => {
    const victim = containerIdFor(
      '8f14e45f-ceea-467a-9b8a-1c2d3e4f5a6b',
      'prj_m1x2y3z4a1b2c3d4',
    );
    const attacker = containerIdFor('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'prj_2yvxr6');

    expect(attacker).not.toBe(victim);
  });

  /**
   * Width is the property that makes grinding infeasible, so it is asserted
   * directly: a future "shorten the id" change is exactly how this comes back.
   */
  it('is wide enough that a collision cannot be ground out', () => {
    const id = containerIdFor('user-a', 'proj-a');

    expect(id).toMatch(/^tacode-[0-9a-f]{32}$/);
  });

  it('is still deterministic, or reconnecting would lose the workspace', () => {
    expect(containerIdFor('user-a', 'proj-a')).toBe(containerIdFor('user-a', 'proj-a'));
  });

  it('separates the two halves of the key, so a fragment cannot be shifted', () => {
    // Without a separator, ("ab","c") and ("a","bc") are the same input.
    expect(containerIdFor('ab', 'c')).not.toBe(containerIdFor('a', 'bc'));
  });

  it('gives different users on the same project different workspaces', () => {
    expect(containerIdFor('user-a', 'shared')).not.toBe(containerIdFor('user-b', 'shared'));
  });
});

// ---------------------------------------------------------------------------
// P0 — symlink escape
// ---------------------------------------------------------------------------

describe('a container that plants a symlink in its own workspace', () => {
  /**
   * `path.resolve` is lexical: it never reads the filesystem, so it cannot know
   * a segment is a link. The old `resolveInWorkspace` compared the resolved
   * string against the root and passed, and the write then followed the link
   * out of the workspace — as whatever user the gateway runs as.
   *
   * The container owns `/workspace`, so planting the link needs no privilege at
   * all: `ln -s /etc escape`.
   */
  it('cannot be written through', async () => {
    const { root, ws, outside } = await workspace();
    try {
      await symlink(outside, join(ws, 'escape'));

      const outcome = applyEditorWrite(
        ws,
        new SyncIndex(),
        { path: 'escape/pwned.txt', content: 'written outside the workspace\n' },
        limits,
      );

      await expect(outcome).rejects.toThrow(PathError);
      await expect(readFile(join(outside, 'pwned.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The same primitive in the other direction, and the worse one: it does not
   * write anything, it reads a host file and delivers it to the browser.
   */
  it('cannot be read through', async () => {
    const { root, ws, outside } = await workspace();
    try {
      await writeFile(join(outside, 'host-secret.txt'), 'HOST SECRET CONTENTS\n');
      await symlink(outside, join(ws, 'escape'));

      const change = await readContainerChange(
        ws,
        new SyncIndex(),
        'escape/host-secret.txt',
        limits,
      );

      expect(change).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cannot smuggle a host file into a manifest', async () => {
    const { root, ws, outside } = await workspace();
    try {
      await writeFile(join(outside, 'host-secret.txt'), 'HOST SECRET CONTENTS\n');
      await symlink(outside, join(ws, 'escape'));

      const manifest = await containerManifest(ws, ['escape/host-secret.txt'], limits);

      expect(manifest).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** A link as the final component, rather than as a directory in the middle. */
  it('cannot be written through a link that is the file itself', async () => {
    const { root, ws, outside } = await workspace();
    try {
      const victim = join(outside, 'target.txt');
      await writeFile(victim, 'original\n');
      await symlink(victim, join(ws, 'innocent.txt'));

      await expect(
        resolveInWorkspaceNoSymlinks(ws, 'innocent.txt'),
      ).rejects.toThrow(PathError);
      expect(await readFile(victim, 'utf8')).toBe('original\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still allows an ordinary nested path that crosses no link', async () => {
    const { root, ws } = await workspace();
    try {
      const outcome = await applyEditorWrite(
        ws,
        new SyncIndex(),
        { path: 'src/deep/nested/app.ts', content: 'export const x = 1;\n' },
        limits,
      );

      expect(outcome.status).toBe('written');
      expect(await readFile(join(ws, 'src/deep/nested/app.ts'), 'utf8')).toBe(
        'export const x = 1;\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A workspace root that is itself reached through a link is ordinary — a
   * root under /var pointing at another volume — and must keep working, or the
   * fix for the escape becomes an outage.
   */
  it('allows a workspace root that is itself a symlink', async () => {
    const { root, ws } = await workspace();
    try {
      const alias = join(root, 'alias');
      await symlink(ws, alias);

      const outcome = await applyEditorWrite(
        alias,
        new SyncIndex(),
        { path: 'app.ts', content: 'fine\n' },
        limits,
      );

      expect(outcome.status).toBe('written');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Path rules the gateway must enforce without help from the browser
// ---------------------------------------------------------------------------

describe('paths the gateway refuses on its own', () => {
  /**
   * The browser's VFS refuses all of these too, and that is irrelevant: the
   * gateway's peer is a socket, and a client that skips the app entirely
   * reaches this code with no browser check having run.
   */
  it.each([
    ['traversal', '../etc/passwd'],
    ['nested traversal', 'src/../../etc/passwd'],
    ['windows traversal', '..\\..\\windows\\system32'],
    ['absolute windows', 'C:\\Windows\\System32'],
    ['null byte', 'app.ts\u0000.png'],
    ['control character', 'app\u0001.ts'],
    ['bare dots', '..'],
    ['empty', ''],
    ['root only', '/'],
  ])('refuses %s', (_label, path) => {
    expect(() => normalizePath(path)).toThrow(PathError);
  });

  /**
   * Percent-encoding is *not* decoded here, and that is the correct behaviour
   * rather than an oversight: this layer receives a path from a JSON frame, not
   * from a URL, so `%2e%2e` is a literal filename. Decoding it would invent a
   * traversal that the caller did not write.
   */
  it('treats percent-encoding as literal characters, not as a traversal', () => {
    expect(normalizePath('%2e%2e/passwd')).toBe('%2e%2e/passwd');
  });

  /**
   * An absolute path is clamped to project-relative rather than refused, and
   * that is the deliberate contract — the same one the browser's VFS has.
   * `/etc/passwd` becomes `etc/passwd`, a file inside the workspace, which
   * cannot escape because the leading slash is what would have made it escape.
   * Asserted explicitly so a future reader does not mistake it for a gap.
   */
  it('clamps an absolute path into the workspace rather than escaping', async () => {
    expect(normalizePath('/etc/passwd')).toBe('etc/passwd');

    const { root, ws } = await workspace();
    try {
      const resolved = await resolveInWorkspaceNoSymlinks(ws, '/etc/passwd');
      expect(resolved).toBe(join(ws, 'etc/passwd'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an ordinary project path', () => {
    expect(normalizePath('src/components/App.tsx')).toBe('src/components/App.tsx');
  });
});

// ---------------------------------------------------------------------------
// P1 — workspace ownership must not fail silently
// ---------------------------------------------------------------------------

describe('preparing a workspace the container can write to', () => {
  /**
   * The chown used to be `.catch(() => {})`, with a comment saying this was
   * "an operator problem worth failing loudly for" — and then not failing.
   * An unprivileged gateway started a container whose every write failed with a
   * permission error that looked like a bug in the user's own code.
   */
  it('fails rather than starting a container that cannot write to its project', async () => {
    const { root, ws } = await workspace();
    try {
      // This process is not root here, so the chown to 10001 cannot succeed and
      // the ownership check must catch it.
      const attempt = prepareWorkspace(ws);

      if (process.getuid?.() === 0) {
        // Running as root the chown does succeed, which is the healthy path.
        await expect(attempt).resolves.toBeUndefined();
      } else {
        await expect(attempt).rejects.toThrow(/could not be prepared/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when the directory is not there at all', async () => {
    await expect(prepareWorkspace('/nonexistent/tacode/workspace')).rejects.toThrow(
      /could not be prepared/i,
    );
  });
});

// ---------------------------------------------------------------------------
// P1 — the disk-quota probe
// ---------------------------------------------------------------------------

describe('the disk quota probe', () => {
  it('names a fresh container every time, so two gateways cannot collide', async () => {
    const names: string[] = [];
    const exec = async (args: string[]) => {
      const at = args.indexOf('--name');
      if (at !== -1) names.push(args[at + 1]);
      return { stdout: '', stderr: '' };
    };

    await probeDiskQuota(exec, 'ta-code/workspace:1');
    await probeDiskQuota(exec, 'ta-code/workspace:1');

    // Both `create` and `rm` name it, so each probe contributes twice.
    const unique = new Set(names);
    expect(unique.size).toBe(2);
    // A timestamp in base 36 is short and monotonic; a UUID is neither.
    for (const name of unique) {
      expect(name).toMatch(
        /^tacode-probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  /**
   * The probe used to pull `busybox:latest`. A floating tag is a mutable
   * dependency inside a security-relevant check, and on a host with no registry
   * access the pull fails — making "cannot reach a registry" indistinguishable
   * from "this daemon cannot enforce quotas", so the quota was silently
   * disabled on every air-gapped host.
   */
  it('probes with the configured workspace image and never a floating tag', async () => {
    const images: string[] = [];
    const runtime = createDockerRuntime({
      image: 'ta-code/workspace@sha256:' + 'a'.repeat(64),
      exec: async (args) => {
        if (args[0] === 'create') images.push(args[args.length - 2]);
        return { stdout: '28.0.0', stderr: '' };
      },
    });

    await runtime.available();

    expect(images).not.toHaveLength(0);
    for (const image of images) {
      expect(image).not.toMatch(/busybox/);
      expect(image).not.toMatch(/:latest$/);
    }
  });
});

// ---------------------------------------------------------------------------
// P1 — container state validation
// ---------------------------------------------------------------------------

describe('whether a container can actually be attached to', () => {
  const runtimeReporting = (status: string) =>
    createDockerRuntime({
      exec: async () => ({ stdout: `${status}\n`, stderr: '' }),
    });

  /**
   * `exists()` returned true for any non-empty output, so an `exited` or `dead`
   * container was reported as present. `ensure()` then handed that record back
   * and the gateway tried to `docker exec` into a corpse, giving the user an
   * opaque failure instead of the fresh container that recreating would have
   * produced.
   */
  it.each(['exited', 'dead', 'removing'])('reports a %s container as gone', async (status) => {
    expect(await runtimeReporting(status).exists('tacode-x')).toBe(false);
  });

  it.each(['running', 'created', 'restarting', 'paused'])(
    'reports a %s container as present',
    async (status) => {
      expect(await runtimeReporting(status).exists('tacode-x')).toBe(true);
    },
  );

  it('reports a container the daemon does not know as gone', async () => {
    const runtime = createDockerRuntime({
      exec: async () => {
        throw new Error('No such object: tacode-x');
      },
    });

    expect(await runtime.exists('tacode-x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2 — a terminal outliving the access that opened it
// ---------------------------------------------------------------------------

describe('when project access is revoked while a terminal is open', () => {
  /**
   * Authorisation happened once, at `hello`, and the terminal then lived for
   * hours. Demoting somebody from editor to viewer, or removing them from the
   * project, left their shell running against files they could no longer open
   * in the editor — the check that admitted them had no expiry.
   *
   * The gateway is built here with a one-second recheck so the test observes
   * the mechanism rather than the default interval.
   */
  it('closes the terminal and kills the session', async () => {
    const { mkdtemp, rm: remove } = await import('node:fs/promises');
    const { tmpdir: tmp } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { default: WebSocket } = await import('ws');
    const { loadConfig } = await import('../src/config.ts');
    const { createGateway } = await import('../src/server.ts');
    const { createLocalRuntime } = await import('../src/runtime/local.ts');
    const { createLogger } = await import('../src/observability.ts');
    const { loadPty } = await import('../src/runtime/pty.ts');
    const { authError } = await import('../src/errors.ts');
    const { PROTOCOL_VERSION } = await import('../../src/lib/terminal/protocol.ts');
    const type = await import('../src/auth.ts');
    void type;

    await loadPty();
    const dir = await mkdtemp(joinPath(tmp(), 'tacode-revoke-'));

    // Mutable on purpose: this is the demotion.
    let role: 'owner' | 'viewer' = 'owner';

    const gateway = createGateway({
      config: {
        ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
        runtime: 'local',
        workspaceRoot: dir,
        roleRecheckSeconds: 1,
      },
      runtime: createLocalRuntime(),
      authorizer: {
        async identify(token) {
          if (token !== 'good') throw authError();
          return { userId: 'user-amina', email: 'a@example.test' };
        },
        async roleOn() {
          return role;
        },
      },
      logger: createLogger(() => undefined),
    });

    await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
    const address = gateway.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/terminal`, {
      origin: 'http://localhost:5173',
    });

    const seen: Array<Record<string, unknown>> = [];
    let closed = false;
    socket.on('message', (raw) => {
      try {
        seen.push(JSON.parse(String(raw)));
      } catch {
        /* not ours */
      }
    });
    socket.on('close', () => {
      closed = true;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          token: 'good',
          projectId: 'proj-alpha',
        }),
      );

      const deadline = Date.now() + 10_000;
      while (!seen.some((frame) => frame.type === 'ready')) {
        if (Date.now() > deadline) throw new Error('terminal never became ready');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const sessionId = String(seen.find((frame) => frame.type === 'ready')?.sessionId);
      expect(gateway.sessions.find(sessionId, 'user-amina')).toBeTruthy();

      // The demotion. Nothing else changes; the socket stays open.
      role = 'viewer';

      const closeBy = Date.now() + 10_000;
      while (!closed) {
        if (Date.now() > closeBy) throw new Error('terminal was not closed after revocation');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const error = seen.find((frame) => frame.type === 'error');
      expect(error?.code).toBe('PERMISSION_ERROR');
      // The shell is gone too. Leaving it running would let the same user
      // reattach to it on their next connection.
      expect(gateway.sessions.find(sessionId, 'user-amina')).toBeNull();
    } finally {
      socket.close();
      await gateway.close();
      await remove(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// The watcher's enumeration
// ---------------------------------------------------------------------------

describe('walking a workspace for a manifest', () => {
  /**
   * `readdir(withFileTypes)` reports a symlink as a symlink, so `isFile()` and
   * `isDirectory()` are both false for one and the walk skips it. That is the
   * correct behaviour and it is also accidental — it falls out of the Dirent
   * API rather than from a decision — so it is asserted here. A future change
   * to `stat`-based classification would silently start enumerating whatever a
   * container linked to.
   */
  it('never enumerates through a symlink, in either shape', async () => {
    const { walkWorkspace } = await import('../src/watcher.ts');
    const { root, ws, outside } = await workspace();
    try {
      await mkdir(join(outside, 'secrets'), { recursive: true });
      await writeFile(join(outside, 'secrets', 'key.txt'), 'HOST SECRET\n');
      await writeFile(join(ws, 'real.ts'), 'ok\n');
      // A linked directory and a linked file: the two ways out.
      await symlink(outside, join(ws, 'escape'));
      await symlink(join(outside, 'secrets', 'key.txt'), join(ws, 'link.txt'));

      const { paths } = await walkWorkspace(ws, 1000);

      expect(paths).toEqual(['real.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not descend into dependency or history directories', async () => {
    const { walkWorkspace } = await import('../src/watcher.ts');
    const { root, ws } = await workspace();
    try {
      await writeFile(join(ws, 'real.ts'), 'ok\n');
      for (const dir of ['node_modules/pkg', '.git', 'dist', '.venv']) {
        await mkdir(join(ws, dir), { recursive: true });
        await writeFile(join(ws, dir, 'file.txt'), 'noise\n');
      }

      const { paths } = await walkWorkspace(ws, 1000);

      expect(paths).toEqual(['real.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
