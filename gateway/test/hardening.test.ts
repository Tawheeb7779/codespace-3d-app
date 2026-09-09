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
import type { Authorizer } from '../src/auth.ts';
import type { ContainerRuntime } from '../src/runtime/types.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * What the gateway does when somebody is not being reasonable.
 *
 * Every limit here is one an ordinary user never reaches and a loop reaches in
 * seconds. They are tested by actually reaching them, because a limit that is
 * configured but never enforced looks exactly like a limit that works, right up
 * until it is needed.
 */

const PROJECT = 'proj-alpha';

const authorizer: Authorizer = {
  async identify(token) {
    if (!token.startsWith('token-')) throw authError();
    return { userId: token.slice(6), email: `${token.slice(6)}@example.test` };
  },
  async roleOn(_userId, projectId) {
    return projectId === PROJECT ? 'owner' : null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;
/** Flipped by a test to make the runtime look unavailable. */
let runtimeUp = true;

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-hard-'));
  const local = createLocalRuntime();
  const runtime: ContainerRuntime = {
    ...local,
    async available() {
      return runtimeUp;
    },
  };

  gateway = createGateway({
    config: {
      ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
      runtime: 'local',
      workspaceRoot: root,
      maxConnections: 4,
      maxConnectionsPerUser: 2,
      // Small enough that one ordinary push exceeds it, so the budget is
      // reached by a normal-looking frame rather than by a contrived one.
      maxSyncBytesPerSecond: 2048,
    },
    runtime,
    authorizer,
    logger: createLogger(() => undefined),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
  url = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
});

const httpBase = () => url.replace('ws://', 'http://');

/** A raw socket, so a test can send frames the real client never would. */
function raw(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}/terminal`, { origin: 'http://localhost:5173' });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function frames(socket: WebSocket): { seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    try {
      seen.push(JSON.parse(String(data)));
    } catch {
      /* not our problem here */
    }
  });
  return { seen };
}

async function hello(socket: WebSocket, token: string): Promise<void> {
  socket.send(
    encodeFrame({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token,
      projectId: PROJECT,
      cols: 80,
      rows: 24,
    }),
  );
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the health endpoint', () => {
  it('reports serving and runtime health as two different things', async () => {
    const response = await fetch(`${httpBase()}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runtimeAvailable).toBe(true);
  });

  /**
   * The case the split exists for. A gateway whose daemon has died is serving
   * perfectly and cannot start a single workspace; answering 200 keeps a load
   * balancer sending it work it will refuse.
   */
  it('answers 503 when the container runtime is gone, while still serving', async () => {
    runtimeUp = false;
    // The check is cached for a few seconds so a probe does not hammer the
    // daemon; waiting past that is what makes this test about the endpoint
    // rather than about the cache.
    await settle(5200);
    try {
      const response = await fetch(`${httpBase()}/health`);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(503);
      expect(body.runtimeAvailable).toBe(false);
      // Still answering, which is the distinction: the process is fine.
      expect(body.ok).toBe(true);
    } finally {
      runtimeUp = true;
    }
  }, 20_000);

  it('says nothing about who is using the gateway', async () => {
    await settle(5200);
    const text = await (await fetch(`${httpBase()}/health`)).text();

    expect(text).not.toMatch(/user|email|project|token/i);
  }, 20_000);
});

describe('too many connections', () => {
  it('refuses a socket past the gateway’s ceiling without accepting it', async () => {
    const held: WebSocket[] = [];
    try {
      // Four is the configured ceiling.
      for (let i = 0; i < 4; i++) held.push(await raw());

      await expect(raw()).rejects.toThrow(/503|unexpected server response/i);
    } finally {
      for (const socket of held) socket.close();
      await settle(200);
    }
  }, 20_000);

  it('refuses a third terminal for one account, and admits another account', async () => {
    const held: WebSocket[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const socket = await raw();
        held.push(socket);
        await hello(socket, 'token-amina');
        await settle(300);
      }

      const third = await raw();
      held.push(third);
      const { seen } = frames(third);
      await hello(third, 'token-amina');
      await settle(500);

      const error = seen.find((frame) => frame.type === 'error');
      expect(error?.code).toBe('RESOURCE_LIMIT');

      // A different account is unaffected: the limit is per user, not a queue.
      const other = await raw();
      held.push(other);
      const secondUser = frames(other);
      await hello(other, 'token-bilal');
      await settle(500);

      expect(secondUser.seen.some((frame) => frame.type === 'ready')).toBe(true);
    } finally {
      for (const socket of held) socket.close();
      await settle(200);
    }
  }, 30_000);
});

describe('pushing files faster than a workspace accepts', () => {
  it('refuses the batch rather than applying part of it', async () => {
    const socket = await raw();
    const { seen } = frames(socket);
    try {
      await hello(socket, 'token-chidi');
      await settle(500);
      const ready = seen.find((frame) => frame.type === 'ready');
      const containerId = String(ready?.containerId);

      // One batch above the per-second byte budget.
      socket.send(
        encodeFrame({
          type: 'sync-push',
          containerId,
          files: [{ path: 'big.txt', content: 'x'.repeat(4096) }],
        }),
      );
      await settle(500);

      const error = seen.find((frame) => frame.type === 'error');
      expect(error?.code).toBe('RESOURCE_LIMIT');
      // Refused whole: no acknowledgement claiming anything was written.
      expect(seen.some((frame) => frame.type === 'sync-ack')).toBe(false);
    } finally {
      socket.close();
      await settle(200);
    }
  }, 30_000);

  it('lets an ordinary push through', async () => {
    const socket = await raw();
    const { seen } = frames(socket);
    try {
      await hello(socket, 'token-dara');
      await settle(500);
      const containerId = String(seen.find((frame) => frame.type === 'ready')?.containerId);

      socket.send(
        encodeFrame({
          type: 'sync-push',
          containerId,
          files: [{ path: 'small.txt', content: 'a modest file\n' }],
        }),
      );
      await settle(500);

      const ack = seen.find((frame) => frame.type === 'sync-ack');
      expect(ack).toBeTruthy();
      expect((ack?.results as Array<{ status: string }>)[0].status).toBe('written');
    } finally {
      socket.close();
      await settle(200);
    }
  }, 30_000);
});

describe('a socket that will not identify itself', () => {
  it('is closed rather than held open indefinitely', async () => {
    const socket = await raw();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const { seen } = frames(socket);

    // Says nothing at all. The handshake deadline is ten seconds.
    await closed;

    expect(seen.some((frame) => frame.type === 'error' && frame.code === 'AUTH_ERROR')).toBe(true);
  }, 20_000);
});

describe('a client naming somebody else’s workspace', () => {
  it('gets the same answer as for one that does not exist', async () => {
    const mine = await raw();
    const theirs = await raw();
    try {
      const first = frames(mine);
      await hello(mine, 'token-emeka');
      await settle(500);
      const containerId = String(first.seen.find((frame) => frame.type === 'ready')?.containerId);

      const second = frames(theirs);
      await hello(theirs, 'token-fatima');
      await settle(500);

      // Fatima naming Emeka's container, which she can see the id of only
      // because this test handed it to her.
      theirs.send(encodeFrame({ type: 'sync-manifest', containerId, files: [] }));
      await settle(400);

      const error = second.seen.find((frame) => frame.type === 'error');
      expect(error?.code).toBe('PERMISSION_ERROR');
      // Nothing about the container: not that it exists, not whose it is.
      expect(String(error?.message)).not.toContain(containerId);
      expect(second.seen.some((frame) => frame.type === 'sync-plan')).toBe(false);
    } finally {
      mine.close();
      theirs.close();
      await settle(200);
    }
  }, 30_000);
});
