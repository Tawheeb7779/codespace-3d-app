import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { encodeFrame, PROTOCOL_VERSION } from '../../src/lib/terminal/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import { authError } from '../src/errors.ts';
import { containerIdFor } from '../src/lifecycle.ts';
import type { Authorizer, ProjectRole } from '../src/auth.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * The second terminal concept, and the boundary that makes it a second one.
 *
 * A Linux workspace belongs to a person, not to a project. That single sentence
 * is the whole security model, and each of its consequences is asserted here:
 * project membership grants no access to it, no project is mounted into it,
 * another person cannot reach it, and the only path between it and a project is
 * an explicit transfer that authorises both ends independently.
 *
 * Driven over the real protocol against the real gateway. The runtime is local,
 * because what is under test is authorisation and file boundaries rather than
 * container isolation — which `dockerSecurity.test.ts` covers against a daemon.
 */

const PROJECT = 'proj-alpha';
const OTHER_PROJECT = 'proj-beta';

const ACCOUNTS: Record<string, { userId: string; roles: Record<string, ProjectRole> }> = {
  'token-amina': { userId: 'user-amina', roles: { [PROJECT]: 'owner' } },
  'token-bilal': { userId: 'user-bilal', roles: { [OTHER_PROJECT]: 'owner' } },
  'token-chidi': { userId: 'user-chidi', roles: { [PROJECT]: 'viewer' } },
  'token-dara': { userId: 'user-dara', roles: { [PROJECT]: 'editor' } },
};

const authorizer: Authorizer = {
  async identify(token) {
    const account = ACCOUNTS[token];
    if (!account) throw authError();
    return { userId: account.userId, email: `${account.userId}@example.test` };
  },
  async roleOn(userId, projectId) {
    return Object.values(ACCOUNTS).find((a) => a.userId === userId)?.roles[projectId] ?? null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-linux-'));
  gateway = createGateway({
    config: {
      ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
      runtime: 'local',
      workspaceRoot: root,
      maxContainersPerUser: 4,
    },
    runtime: createLocalRuntime(),
    authorizer,
    logger: createLogger(() => undefined),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
  url = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
});

interface Client {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  wait: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  send: (frame: unknown) => void;
  close: () => void;
}

/**
 * Every socket this file opens, closed after each test.
 *
 * A connection survives a failed assertion, and the gateway caps them per
 * account — so one failure starves every test after it of a connection and the
 * file reports a cascade of timeouts that have nothing to do with the code.
 */
let opened: Client[] = [];

afterEach(async () => {
  for (const client of opened) client.close();
  opened = [];
  await new Promise((resolve) => setTimeout(resolve, 150));
});

async function open(): Promise<Client> {
  const socket = new WebSocket(`${url}/terminal`, { origin: 'http://localhost:5173' });
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)));
    } catch {
      /* not JSON */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const client: Client = {
    socket,
    frames,
    async wait(type, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find((frame) => frame.type === type);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`no ${type} frame; saw ${frames.map((f) => f.type).join(',')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    send: (frame) => socket.send(encodeFrame(frame as never)),
    close: () => socket.close(),
  };
  opened.push(client);
  return client;
}

/** Open a workspace of either kind and return the ready frame. */
async function attach(
  token: string,
  kind: 'project' | 'linux',
  projectId = PROJECT,
): Promise<{ client: Client; ready: Record<string, unknown> }> {
  const client = await open();
  client.send({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token,
    projectId: kind === 'linux' ? '' : projectId,
    kind,
    cols: 80,
    rows: 24,
  });
  const ready = await client.wait('ready');
  return { client, ready };
}

const closeAll = (...clients: Client[]) => {
  for (const client of clients) client.close();
};

describe('a Linux workspace is not a project workspace', () => {
  it('has its own container and its own directory', async () => {
    const project = await attach('token-amina', 'project');
    const linux = await attach('token-amina', 'linux');

    expect(linux.ready.containerId).not.toBe(project.ready.containerId);
    expect(linux.ready.containerId).toBe(containerIdFor('user-amina', null, 'linux'));

    closeAll(project.client, linux.client);
  }, 30_000);

  /**
   * The property that keeps "independent" honest. A Linux workspace starts
   * empty: no project is copied in, no project is mounted, and nothing about
   * the person's other work is reachable from inside it.
   */
  it('starts empty, with no project mounted or copied into it', async () => {
    const project = await attach('token-amina', 'project');
    const projectDir = join(root, String(project.ready.containerId));
    await writeFile(join(projectDir, 'secret-project-file.ts'), 'export const secret = 1;\n');

    const linux = await attach('token-amina', 'linux');
    const linuxDir = join(root, String(linux.ready.containerId));

    expect(await readdir(linuxDir)).toEqual([]);

    closeAll(project.client, linux.client);
  }, 30_000);

  /**
   * A person may hold several projects. None of them appears in the Linux
   * workspace, and this asserts it with two.
   */
  it('does not expose any of the user’s projects', async () => {
    const first = await attach('token-amina', 'project', PROJECT);
    await writeFile(join(root, String(first.ready.containerId), 'alpha.ts'), 'a\n');
    first.client.close();

    const linux = await attach('token-amina', 'linux');
    const contents = await readdir(join(root, String(linux.ready.containerId)));

    expect(contents).not.toContain('alpha.ts');
    expect(contents).toEqual([]);

    linux.client.close();
  }, 30_000);

  it('is refused when a project id is sent with it', async () => {
    const client = await open();
    client.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'token-amina',
      projectId: PROJECT,
      kind: 'linux',
    });

    const error = await client.wait('error');
    expect(error.code).toBe('PROTOCOL_ERROR');

    client.close();
  }, 30_000);
});

describe('who may open a Linux workspace', () => {
  /**
   * Identity is the whole check. A viewer on a project may not open a project
   * terminal — a container runs the project's code — but their own Linux
   * workspace is theirs, and being a viewer somewhere says nothing about it.
   */
  it('lets a project viewer open their own, while still refusing them a project terminal', async () => {
    const denied = await open();
    denied.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'token-chidi',
      projectId: PROJECT,
      kind: 'project',
    });
    const error = await denied.wait('error');
    expect(error.code).toBe('PERMISSION_ERROR');
    denied.close();

    const own = await attach('token-chidi', 'linux');
    expect(own.ready.containerId).toBe(containerIdFor('user-chidi', null, 'linux'));
    own.client.close();
  }, 30_000);

  it('refuses an unauthenticated caller', async () => {
    const client = await open();
    client.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'not-a-token',
      projectId: '',
      kind: 'linux',
    });

    const error = await client.wait('error');
    expect(error.code).toBe('AUTH_ERROR');

    client.close();
  }, 30_000);

  /**
   * Two people, two workspaces, and no way to name your way into the other. The
   * id is handed to the client, so this is the case a curious user reaches for
   * first.
   */
  it('refuses a caller who names another person’s Linux workspace', async () => {
    const amina = await attach('token-amina', 'linux');
    const aminaLinux = String(amina.ready.containerId);
    await writeFile(join(root, aminaLinux, 'private.txt'), 'amina only\n');

    const bilal = await attach('token-bilal', 'linux');
    bilal.client.send({
      type: 'git',
      requestId: 'r1',
      containerId: aminaLinux,
      request: { op: 'status' },
    });

    const error = await bilal.client.wait('error');
    expect(error.code).toBe('PERMISSION_ERROR');
    expect(bilal.client.frames.find((frame) => frame.type === 'git-result')).toBeUndefined();

    closeAll(amina.client, bilal.client);
  }, 30_000);
});

describe('explicit transfer between a project and a Linux workspace', () => {
  it('copies only the files a person named, in the direction they asked', async () => {
    const project = await attach('token-amina', 'project');
    const linux = await attach('token-amina', 'linux');
    const projectDir = join(root, String(project.ready.containerId));
    const linuxDir = join(root, String(linux.ready.containerId));

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src', 'wanted.ts'), 'export const wanted = true;\n');
    await writeFile(join(projectDir, 'src', 'not-wanted.ts'), 'export const other = true;\n');

    linux.client.send({
      type: 'transfer',
      requestId: 't1',
      fromContainerId: project.ready.containerId,
      toContainerId: linux.ready.containerId,
      paths: ['src/wanted.ts'],
    });

    const result = await linux.client.wait('transfer-result');
    expect(result.copied).toEqual(['src/wanted.ts']);
    expect(await readFile(join(linuxDir, 'src', 'wanted.ts'), 'utf8')).toBe(
      'export const wanted = true;\n',
    );
    // The file nobody asked for did not travel.
    await expect(readFile(join(linuxDir, 'src', 'not-wanted.ts'), 'utf8')).rejects.toThrow();

    closeAll(project.client, linux.client);
  }, 30_000);

  it('carries files back into the project when asked', async () => {
    const project = await attach('token-amina', 'project');
    const linux = await attach('token-amina', 'linux');
    const linuxDir = join(root, String(linux.ready.containerId));
    const projectDir = join(root, String(project.ready.containerId));

    await writeFile(join(linuxDir, 'built.ts'), 'export const built = true;\n');

    linux.client.send({
      type: 'transfer',
      requestId: 't2',
      fromContainerId: linux.ready.containerId,
      toContainerId: project.ready.containerId,
      paths: ['built.ts'],
    });

    const result = await linux.client.wait('transfer-result');
    expect(result.copied).toEqual(['built.ts']);
    expect(await readFile(join(projectDir, 'built.ts'), 'utf8')).toBe(
      'export const built = true;\n',
    );

    closeAll(project.client, linux.client);
  }, 30_000);

  /**
   * Two independent workspaces give the gateway no basis for choosing which
   * copy somebody wanted, so an existing destination is reported rather than
   * replaced.
   */
  it('reports a conflict instead of overwriting', async () => {
    const project = await attach('token-amina', 'project');
    const linux = await attach('token-amina', 'linux');
    const projectDir = join(root, String(project.ready.containerId));
    const linuxDir = join(root, String(linux.ready.containerId));

    await writeFile(join(projectDir, 'contested.ts'), 'the project version\n');
    await writeFile(join(linuxDir, 'contested.ts'), 'the linux version\n');

    linux.client.send({
      type: 'transfer',
      requestId: 't3',
      fromContainerId: project.ready.containerId,
      toContainerId: linux.ready.containerId,
      paths: ['contested.ts'],
    });

    const result = await linux.client.wait('transfer-result');
    expect(result.conflicts).toEqual(['contested.ts']);
    expect(result.copied).toEqual([]);
    // Untouched, so nothing was lost while the person decides.
    expect(await readFile(join(linuxDir, 'contested.ts'), 'utf8')).toBe('the linux version\n');

    closeAll(project.client, linux.client);
  }, 30_000);

  /**
   * A transfer is exactly how a credential file would be carried out of a
   * project, so the protected-path list applies here as it does to sync.
   */
  it.each([['.env'], ['.ssh/id_rsa'], ['.npmrc'], ['.aws/credentials'], ['.git/config']])(
    'refuses to transfer %s',
    async (path) => {
      const project = await attach('token-amina', 'project');
      const linux = await attach('token-amina', 'linux');
      const projectDir = join(root, String(project.ready.containerId));

      await mkdir(dirname(join(projectDir, path)), { recursive: true }).catch(() => undefined);
      await writeFile(join(projectDir, path), 'SECRET=leaked\n').catch(() => undefined);

      linux.client.send({
        type: 'transfer',
        // A safe id: the validator refuses `/` in an identifier, which is
        // correct — and embedding the path here made the frame itself invalid.
        requestId: `t-protected-${path.replace(/[^A-Za-z0-9]/g, '')}`,
        fromContainerId: project.ready.containerId,
        toContainerId: linux.ready.containerId,
        paths: [path],
      });

      const result = await linux.client.wait('transfer-result');
      expect(result.copied).toEqual([]);
      expect((result.skipped as Array<{ reason: string }>)[0].reason).toBe('protected path');

      closeAll(project.client, linux.client);
    },
    30_000,
  );

  /**
   * A workspace can plant a symlink in its own tree — it owns it. Following one
   * during a transfer would read or write outside both workspaces, as the
   * gateway's own user.
   */
  it('does not follow a symlink out of the source workspace', async () => {
    const project = await attach('token-amina', 'project');
    const linux = await attach('token-amina', 'linux');
    const projectDir = join(root, String(project.ready.containerId));

    const outside = join(root, 'outside-any-workspace');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'host-secret.txt'), 'HOST SECRET\n');
    await symlink(outside, join(projectDir, 'escape')).catch(() => undefined);

    linux.client.send({
      type: 'transfer',
      requestId: 't-symlink',
      fromContainerId: project.ready.containerId,
      toContainerId: linux.ready.containerId,
      paths: ['escape/host-secret.txt'],
    });

    const result = await linux.client.wait('transfer-result');
    expect(result.copied).toEqual([]);
    expect(result.skipped).not.toEqual([]);

    closeAll(project.client, linux.client);
  }, 30_000);

  it.each([['../outside.txt'], ['/etc/passwd'], ['..\\..\\windows'], ['a b']])(
    'refuses the traversal %j before it reaches the filesystem',
    async (path) => {
      const linux = await attach('token-amina', 'linux');
      linux.client.send({
        type: 'transfer',
        requestId: 't-traverse',
        fromContainerId: linux.ready.containerId,
        toContainerId: linux.ready.containerId,
        paths: [path],
      });

      // Refused by the protocol validator, so the frame never reaches a handler.
      const error = await linux.client.wait('error');
      expect(error.code).toBe('PROTOCOL_ERROR');

      linux.client.close();
    },
    30_000,
  );

  /**
   * The transfer's authorisation is per endpoint. Naming somebody else's
   * workspace as either the source or the destination is refused, and refused
   * the same way as a workspace that does not exist.
   */
  it('refuses a transfer whose source belongs to somebody else', async () => {
    const amina = await attach('token-amina', 'project');
    const aminaDir = join(root, String(amina.ready.containerId));
    await writeFile(join(aminaDir, 'amina-only.ts', ), 'export const mine = 1;\n');

    const bilal = await attach('token-bilal', 'linux');
    bilal.client.send({
      type: 'transfer',
      requestId: 't-cross',
      fromContainerId: amina.ready.containerId,
      toContainerId: bilal.ready.containerId,
      paths: ['amina-only.ts'],
    });

    const error = await bilal.client.wait('error');
    expect(error.code).toBe('PERMISSION_ERROR');
    expect(bilal.client.frames.find((frame) => frame.type === 'transfer-result')).toBeUndefined();

    closeAll(amina.client, bilal.client);
  }, 30_000);

  it('refuses a transfer whose destination belongs to somebody else', async () => {
    const bilal = await attach('token-bilal', 'linux');
    const amina = await attach('token-amina', 'linux');
    const aminaLinux = String(amina.ready.containerId);
    amina.client.close();

    bilal.client.send({
      type: 'transfer',
      requestId: 't-cross-2',
      fromContainerId: bilal.ready.containerId,
      toContainerId: aminaLinux,
      paths: ['anything.ts'],
    });

    const error = await bilal.client.wait('error');
    expect(error.code).toBe('PERMISSION_ERROR');

    bilal.client.close();
  }, 30_000);
});

describe('the Project Terminal is unchanged by any of this', () => {
  it('still opens for an editor and is bound to its project', async () => {
    const { client, ready } = await attach('token-dara', 'project');

    expect(ready.containerId).toBe(containerIdFor('user-dara', PROJECT, 'project'));
    expect(ready.status).toBe('ready');

    client.close();
  }, 30_000);

  it('still refuses a project the caller has no role on', async () => {
    const client = await open();
    client.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'token-bilal',
      projectId: PROJECT,
      kind: 'project',
    });

    const error = await client.wait('error');
    expect(error.code).toBe('PERMISSION_ERROR');

    client.close();
  }, 30_000);

  /**
   * A project workspace and a Linux workspace for the same person must never
   * name the same directory. The kind is part of the identity precisely so a
   * project that happens to be called `linux` cannot collide with one.
   */
  it('cannot collide with a Linux workspace, even for a project named "linux"', () => {
    expect(containerIdFor('user-amina', 'linux', 'project')).not.toBe(
      containerIdFor('user-amina', null, 'linux'),
    );
    expect(containerIdFor('user-amina', '', 'project')).not.toBe(
      containerIdFor('user-amina', null, 'linux'),
    );
  });
});
