import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { encodeFrame, PROTOCOL_VERSION } from '../../src/lib/terminal/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import { authError } from '../src/errors.ts';
import type { Authorizer, ProjectRole } from '../src/auth.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * Losing access to a project, while still owning its workspace.
 *
 * A container record keeps the user id of whoever created it, so `byId` keeps
 * answering for that person for as long as the container lives — including
 * after their membership of the project has been taken away. The periodic
 * revalidation does not cover it either: that walks the role a socket announced
 * at `hello`, and a sync, git, check or transfer frame names a workspace by
 * container id, which a socket never announced.
 *
 * That was the gap. These tests reach it the only way it can be reached: get a
 * workspace legitimately, take the role away, and then address the workspace
 * that is still owned. Every frame that carries a `containerId` is exercised,
 * because the check has to be on all of them or it is on none of them.
 *
 * The revalidation interval is set far beyond the life of the suite, so a
 * refusal here is the per-frame check and never the background sweep.
 */

const PROJECT = 'proj-authz';
const USER = 'user-nadia';

/** Mutable so a test can take access away mid-connection, as a real removal does. */
const roles = new Map<string, ProjectRole | null>([[PROJECT, 'owner']]);

const authorizer: Authorizer = {
  async identify(token) {
    if (token !== 'good-token') throw authError();
    return { userId: USER, email: 'nadia@example.test' };
  },
  async roleOn(_userId, projectId) {
    return roles.get(projectId) ?? null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-authz-'));
  gateway = createGateway({
    config: {
      ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
      runtime: 'local',
      workspaceRoot: root,
      // Long enough that the background sweep never runs during this suite.
      roleRecheckSeconds: 3600,
    },
    runtime: createLocalRuntime(),
    authorizer,
    logger: createLogger(() => undefined),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
  url = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
  roles.set(PROJECT, 'owner');
});

interface Socket {
  socket: WebSocket;
  seen: Array<Record<string, unknown>>;
  containerId: string;
  sessionId: string;
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** A raw socket taken all the way to `ready`, so its workspace id is known. */
async function connect(projectId: string, kind: 'project' | 'linux' = 'project'): Promise<Socket> {
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(`${url}/terminal`, { origin: 'http://localhost:5173' });
    candidate.once('open', () => resolve(candidate));
    candidate.once('error', reject);
  });

  const seen: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    try {
      seen.push(JSON.parse(String(data)) as Record<string, unknown>);
    } catch {
      /* output frames that are not JSON are not what this suite reads */
    }
  });

  socket.send(
    encodeFrame({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'good-token',
      projectId,
      kind,
      cols: 80,
      rows: 24,
    }),
  );

  const ready = await waitFor(seen, (frame) => frame.type === 'ready');
  return { socket, seen, containerId: String(ready.containerId), sessionId: String(ready.sessionId) };
}

async function waitFor(
  seen: Array<Record<string, unknown>>,
  match: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = seen.find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`no matching frame within ${timeoutMs}ms; saw ${seen.map((f) => f.type).join(', ')}`);
    }
    await settle(50);
  }
}

/** Send one frame and return whatever the gateway answered with afterwards. */
async function ask(
  connection: Socket,
  frame: Parameters<typeof encodeFrame>[0],
): Promise<Array<Record<string, unknown>>> {
  const from = connection.seen.length;
  connection.socket.send(encodeFrame(frame));
  await settle(400);
  return connection.seen.slice(from);
}

const refused = (answers: Array<Record<string, unknown>>): boolean =>
  answers.some((frame) => frame.type === 'error' && frame.code === 'PERMISSION_ERROR');

describe('a workspace whose project access has been revoked', () => {
  /**
   * The whole point, stated once: the container is still theirs, and that is
   * no longer enough.
   */
  it('refuses sync for a container the caller still owns', async () => {
    const connection = await connect(PROJECT);
    try {
      const allowed = await ask(connection, {
        type: 'sync-manifest',
        containerId: connection.containerId,
        files: [],
      });
      expect(refused(allowed)).toBe(false);
      expect(allowed.some((frame) => frame.type === 'sync-plan')).toBe(true);

      roles.set(PROJECT, null);
      const denied = await ask(connection, {
        type: 'sync-manifest',
        containerId: connection.containerId,
        files: [],
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  it('refuses a push of file content', async () => {
    const connection = await connect(PROJECT);
    try {
      roles.set(PROJECT, null);
      const denied = await ask(connection, {
        type: 'sync-push',
        containerId: connection.containerId,
        files: [{ path: 'notes.txt', content: 'written after removal' }],
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  it('refuses a delete', async () => {
    const connection = await connect(PROJECT);
    try {
      roles.set(PROJECT, null);
      const denied = await ask(connection, {
        type: 'sync-delete',
        containerId: connection.containerId,
        paths: ['notes.txt'],
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  it('refuses git', async () => {
    const connection = await connect(PROJECT);
    try {
      roles.set(PROJECT, null);
      const denied = await ask(connection, {
        type: 'git',
        requestId: 'req-git',
        containerId: connection.containerId,
        request: { op: 'status' },
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  it('refuses a check, which is how the agent reaches the workspace', async () => {
    const connection = await connect(PROJECT);
    try {
      roles.set(PROJECT, null);
      const denied = await ask(connection, {
        type: 'check',
        requestId: 'req-check',
        containerId: connection.containerId,
        request: { op: 'list' },
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  /**
   * A transfer reads one workspace and writes another, so the source is as much
   * an access decision as the destination. Checking only the destination would
   * turn the transfer into a way to read a project you have been removed from.
   */
  it('refuses a transfer out of it, not only into it', async () => {
    const project = await connect(PROJECT);
    const linux = await connect('', 'linux');
    try {
      roles.set(PROJECT, null);
      const denied = await ask(linux, {
        type: 'transfer',
        requestId: 'req-transfer',
        fromContainerId: project.containerId,
        toContainerId: linux.containerId,
        paths: ['notes.txt'],
        overwrite: true,
      });

      expect(refused(denied)).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      project.socket.close();
      linux.socket.close();
    }
  }, 20_000);
});

describe('authorised work is unaffected', () => {
  it('lets an editor sync, run git and list checks', async () => {
    roles.set(PROJECT, 'editor');
    const connection = await connect(PROJECT);
    try {
      const synced = await ask(connection, {
        type: 'sync-manifest',
        containerId: connection.containerId,
        files: [],
      });
      expect(synced.some((frame) => frame.type === 'sync-plan')).toBe(true);

      const git = await ask(connection, {
        type: 'git',
        requestId: 'req-ok-git',
        containerId: connection.containerId,
        request: { op: 'status' },
      });
      expect(refused(git)).toBe(false);
      expect(git.some((frame) => frame.type === 'git-result')).toBe(true);

      const checks = await ask(connection, {
        type: 'check',
        requestId: 'req-ok-check',
        containerId: connection.containerId,
        request: { op: 'list' },
      });
      expect(refused(checks)).toBe(false);
      expect(checks.some((frame) => frame.type === 'check-result')).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      connection.socket.close();
    }
  }, 20_000);

  /**
   * A Linux workspace has no project and no membership to lose. Requiring a
   * role there would refuse a workspace that is authorised by identity alone —
   * the person is still the person.
   */
  it('lets a Linux workspace sync with no project role at all', async () => {
    const linux = await connect('', 'linux');
    try {
      roles.set(PROJECT, null);
      const answers = await ask(linux, {
        type: 'sync-manifest',
        containerId: linux.containerId,
        files: [],
      });

      expect(refused(answers)).toBe(false);
      expect(answers.some((frame) => frame.type === 'sync-plan')).toBe(true);
    } finally {
      roles.set(PROJECT, 'owner');
      linux.socket.close();
    }
  }, 20_000);
});

describe('a terminal session addressed from the wrong socket', () => {
  /**
   * One person, two workspaces, two sockets. Each socket was admitted to the
   * workspace it announced at `hello`; owning the other one does not make it
   * addressable from here.
   */
  it('refuses input for a session in a container this socket did not open', async () => {
    const project = await connect(PROJECT);
    const linux = await connect('', 'linux');
    try {
      const denied = await ask(linux, {
        type: 'input',
        sessionId: project.sessionId,
        data: Buffer.from('echo crossed\n').toString('base64'),
      });

      expect(refused(denied)).toBe(true);

      // The socket that does own the session still works, so the check is
      // about the pairing rather than about the session being unusable.
      const allowed = await ask(project, {
        type: 'input',
        sessionId: project.sessionId,
        data: Buffer.from('echo fine\n').toString('base64'),
      });
      expect(refused(allowed)).toBe(false);
    } finally {
      project.socket.close();
      linux.socket.close();
    }
  }, 20_000);
});
