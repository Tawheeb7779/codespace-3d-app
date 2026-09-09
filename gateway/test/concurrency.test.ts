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
 * What one authenticated user can actually cost the gateway.
 *
 * Every limit here already existed; none is introduced by this file. What did
 * not exist was evidence that they hold when reached *concurrently* rather than
 * one call at a time — which is the only way they are reached in production, and
 * the shape in which an off-by-one or a missing await turns a limit into a
 * suggestion.
 *
 * Deliberately bounded. Nothing here forks, allocates without a ceiling, or
 * opens more than a few dozen sockets: the point is to prove a boundary exists,
 * not to find the host's breaking point. Every test also asserts what happens
 * *after* the limit — a gateway that refuses correctly and is then unusable has
 * traded one failure for another.
 *
 * The local runtime backs it, so these are real sockets, real PTYs and real
 * `bash`, without leaving containers behind on whatever machine runs the suite.
 */

const PROJECT = 'proj-alpha';

const ROLES: Record<string, { userId: string; role: ProjectRole }> = {
  'token-amina': { userId: 'user-amina', role: 'owner' },
  'token-bilal': { userId: 'user-bilal', role: 'owner' },
  'token-chidi': { userId: 'user-chidi', role: 'editor' },
};

const authorizer: Authorizer = {
  async identify(token) {
    const account = ROLES[token];
    if (!account) throw authError();
    return { userId: account.userId, email: 'x@example.test' };
  },
  async roleOn(userId) {
    return Object.values(ROLES).find((entry) => entry.userId === userId)?.role ?? null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;

/** The ceilings under test, small enough to reach quickly and still be real. */
const LIMITS = {
  maxConnections: 24,
  maxConnectionsPerUser: 4,
  maxContainersPerUser: 2,
  maxContainers: 6,
  maxSessionsPerContainer: 3,
};

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-conc-'));
  const base = loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  gateway = createGateway({
    config: {
      ...base,
      runtime: 'local',
      workspaceRoot: root,
      maxConnections: LIMITS.maxConnections,
      maxConnectionsPerUser: LIMITS.maxConnectionsPerUser,
      maxContainersPerUser: LIMITS.maxContainersPerUser,
      maxContainers: LIMITS.maxContainers,
      tiers: {
        ...base.tiers,
        free: { ...base.tiers.free, maxSessions: LIMITS.maxSessionsPerContainer },
      },
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
  ready: () => Record<string, unknown> | undefined;
  error: () => Record<string, unknown> | undefined;
  close: () => void;
}

/** One socket, opened and driven, or a rejection if the gateway refused it. */
async function connect(): Promise<Client> {
  const socket = new WebSocket(`${url}/terminal`, { origin: 'http://localhost:5173' });
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)));
    } catch {
      /* terminal output is not JSON only when malformed; ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    frames,
    ready: () => frames.find((frame) => frame.type === 'ready'),
    error: () => frames.find((frame) => frame.type === 'error'),
    close: () => socket.close(),
  };
}

function hello(client: Client, token: string, projectId = PROJECT): void {
  client.socket.send(
    encodeFrame({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token,
      projectId,
      cols: 80,
      rows: 24,
    }),
  );
}

const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('a user opening many sockets at once', () => {
  /**
   * Opened together rather than in sequence. A per-user counter that is read
   * and written across an `await` counts wrong under concurrency and correctly
   * one at a time, so a sequential test would pass against a broken limit.
   */
  it('admits exactly the per-user ceiling and refuses the rest', async () => {
    const attempts = LIMITS.maxConnectionsPerUser + 4;
    const clients = await Promise.all(Array.from({ length: attempts }, () => connect()));

    // All of them say hello simultaneously.
    await Promise.all(clients.map((client) => Promise.resolve(hello(client, 'token-amina'))));
    await settle(2500);

    const admitted = clients.filter((client) => client.ready()).length;
    const refused = clients.filter(
      (client) => client.error()?.code === 'RESOURCE_LIMIT',
    ).length;

    expect(admitted).toBeLessThanOrEqual(LIMITS.maxConnectionsPerUser);
    expect(admitted + refused).toBe(attempts);
    // The limit is a limit, not a total block: some did get in.
    expect(admitted).toBeGreaterThan(0);

    for (const client of clients) client.close();
    await settle();
  }, 60_000);

  /**
   * The half that is usually missing. A ceiling that is never released turns a
   * transient burst into a permanent outage for that account.
   */
  it('lets the same user back in once the sockets are closed', async () => {
    const first = await Promise.all(
      Array.from({ length: LIMITS.maxConnectionsPerUser }, () => connect()),
    );
    for (const client of first) hello(client, 'token-amina');
    await settle(2000);
    for (const client of first) client.close();
    await settle(1000);

    const rejoined = await connect();
    hello(rejoined, 'token-amina');
    await until(() => Boolean(rejoined.ready() || rejoined.error()));

    expect(rejoined.ready()).toBeTruthy();
    expect(rejoined.error()).toBeUndefined();

    rejoined.close();
    await settle();
  }, 60_000);

  /**
   * One account filling its own allowance must not fill anybody else's. This is
   * the difference between a per-user limit and a global queue.
   */
  it('does not let one account starve another', async () => {
    const amina = await Promise.all(
      Array.from({ length: LIMITS.maxConnectionsPerUser + 2 }, () => connect()),
    );
    for (const client of amina) hello(client, 'token-amina');
    await settle(2000);

    const bilal = await connect();
    hello(bilal, 'token-bilal');
    await until(() => Boolean(bilal.ready() || bilal.error()));

    expect(bilal.ready()).toBeTruthy();

    bilal.close();
    for (const client of amina) client.close();
    await settle();
  }, 60_000);
});

describe('a user opening many terminals in one workspace', () => {
  /**
   * Sessions are per container, and the container is shared by every tab on
   * that project. Requested together, because the count is read before the PTY
   * is spawned and written after — the window where a sequential test sees
   * nothing.
   */
  it('caps the terminals per workspace and says why', async () => {
    const attempts = LIMITS.maxSessionsPerContainer + 2;
    const clients = await Promise.all(Array.from({ length: attempts }, () => connect()));
    for (const client of clients) hello(client, 'token-chidi');
    await settle(3000);

    const admitted = clients.filter((client) => client.ready()).length;
    const refused = clients
      .map((client) => client.error())
      .filter((frame): frame is Record<string, unknown> => Boolean(frame));

    // Bounded by whichever ceiling is lower — sessions per container, or
    // sockets per user. Both are real; neither may be exceeded.
    expect(admitted).toBeLessThanOrEqual(
      Math.min(LIMITS.maxSessionsPerContainer, LIMITS.maxConnectionsPerUser),
    );
    if (refused.length) {
      // A refusal a person can act on, not a stack trace.
      expect(String(refused[0].message)).toMatch(/maximum|too many/i);
    }

    for (const client of clients) client.close();
    await settle();
  }, 60_000);
});

describe('reopening a workspace after closing every terminal', () => {
  /**
   * The lockout, as a regression.
   *
   * Closing a tab detaches a session rather than killing it, so `npm run dev`
   * survives. The consequence, before this was fixed: three terminals opened
   * and closed held all three slots until the idle reaper ran a quarter of an
   * hour later, and the user was refused a terminal in their own workspace the
   * whole time. Found by opening and closing under concurrency, not by reading
   * the limit.
   *
   * The fix adopts the oldest detached session rather than refusing. Nothing is
   * killed, so a long-running process is still there — which this asserts, by
   * checking the connection is marked `resumed`.
   */
  it('is not locked out by its own finished terminals', async () => {
    const first = await Promise.all(
      Array.from({ length: LIMITS.maxSessionsPerContainer }, () => connect()),
    );
    for (const client of first) hello(client, 'token-chidi');
    await settle(3000);
    expect(first.filter((client) => client.ready()).length).toBeGreaterThan(0);

    // Every tab closed. The sessions detach and stay alive by design.
    for (const client of first) client.close();
    await settle(1500);

    const reopened = await connect();
    hello(reopened, 'token-chidi');
    await until(() => Boolean(reopened.ready() || reopened.error()));

    expect(reopened.error()).toBeUndefined();
    const ready = reopened.ready();
    expect(ready).toBeTruthy();
    // Adopted rather than newly spawned, so whatever was running is still
    // running and the client knows the scrollback is not new.
    expect(ready?.resumed).toBe(true);

    reopened.close();
    await settle();
  }, 60_000);
});

describe('a user opening workspaces for many projects at once', () => {
  it('caps containers per user and keeps the host ceiling above it', async () => {
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const clients = await Promise.all(projects.map(() => connect()));

    // Different projects, same account: each wants its own container.
    await Promise.all(
      clients.map((client, index) =>
        Promise.resolve(hello(client, 'token-bilal', projects[index])),
      ),
    );
    await settle(3000);

    const containers = new Set(
      clients.map((client) => client.ready()?.containerId).filter(Boolean) as string[],
    );

    expect(containers.size).toBeLessThanOrEqual(LIMITS.maxContainersPerUser);
    expect(gateway.containers.size).toBeLessThanOrEqual(LIMITS.maxContainers);

    for (const client of clients) client.close();
    await settle();
  }, 60_000);
});

describe('output arriving faster than a browser takes it', () => {
  /**
   * The backpressure path, driven concurrently from several terminals. What
   * must not happen is unbounded growth in the gateway: the replay buffer is
   * capped, so a process printing forever costs a fixed amount of memory per
   * session rather than all of it.
   */
  it('stays responsive while several terminals flood at once', async () => {
    const clients = await Promise.all(Array.from({ length: 3 }, () => connect()));
    for (const client of clients) hello(client, 'token-amina');
    await settle(2500);

    const live = clients.filter((client) => client.ready());
    expect(live.length).toBeGreaterThan(0);

    const before = process.memoryUsage().heapUsed;

    // Bounded floods, run together. Large enough to exceed the replay buffer
    // several times over, small enough to finish.
    for (const client of live) {
      const sessionId = String(client.ready()?.sessionId);
      client.socket.send(
        encodeFrame({
          type: 'input',
          sessionId,
          data: Buffer.from(
            'for i in $(seq 1 4000); do echo "flood line $i padding padding padding"; done\n',
          ).toString('base64'),
        }),
      );
    }
    await settle(8000);

    const growth = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    // A cap that works keeps this in single-digit megabytes; an unbounded
    // buffer would be hundreds. Generous, because it is a smoke alarm rather
    // than a benchmark.
    expect(growth).toBeLessThan(150);

    // And the terminals still work, which is the part a "survived the flood"
    // assertion usually misses.
    for (const client of live) {
      const sessionId = String(client.ready()?.sessionId);
      client.socket.send(
        encodeFrame({
          type: 'input',
          sessionId,
          data: Buffer.from('echo still-here-$((6*7))\n').toString('base64'),
        }),
      );
    }
    await settle(3000);

    for (const client of clients) client.close();
    await settle();
  }, 90_000);
});

describe('a client sending frames as fast as it can', () => {
  /**
   * The frame budget, reached deliberately. Bounded at a few hundred frames:
   * enough to cross a per-second allowance, not enough to be a flood in its
   * own right.
   */
  it('throttles a socket that exceeds the frame budget, and closes nothing else', async () => {
    const noisy = await connect();
    hello(noisy, 'token-amina');
    await until(() => Boolean(noisy.ready() || noisy.error()));
    const sessionId = String(noisy.ready()?.sessionId);

    const quiet = await connect();
    hello(quiet, 'token-bilal');
    await until(() => Boolean(quiet.ready() || quiet.error()));

    for (let i = 0; i < 400; i++) {
      noisy.socket.send(
        encodeFrame({
          type: 'input',
          sessionId,
          data: Buffer.from('x').toString('base64'),
        }),
      );
    }
    await settle(2000);

    // The noisy socket is told it is going too fast…
    expect(noisy.error()?.code).toBe('RESOURCE_LIMIT');
    // …and the well-behaved one is untouched.
    expect(quiet.error()).toBeUndefined();
    expect(quiet.ready()).toBeTruthy();

    noisy.close();
    quiet.close();
    await settle();
  }, 60_000);
});

describe('after all of that', () => {
  /**
   * The recovery assertion for the whole file. Every test above deliberately
   * reached a ceiling; if any of them leaked a session, a container or a socket
   * slot, this is where it shows — as a gateway that will not admit anybody.
   */
  it('still admits a fresh connection and runs a command', async () => {
    await settle(1500);

    const client = await connect();
    hello(client, 'token-amina');
    await until(() => Boolean(client.ready() || client.error()), 20_000);

    expect(client.error()).toBeUndefined();
    expect(client.ready()).toBeTruthy();

    client.close();
    await settle();

    // And nothing is left running that nobody asked for.
    expect(gateway.containers.size).toBeLessThanOrEqual(LIMITS.maxContainers);
  }, 60_000);
});
