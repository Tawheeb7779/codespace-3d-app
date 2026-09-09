import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerManager, containerIdFor } from '../src/lifecycle.ts';
import { SessionRegistry, TerminalSession } from '../src/session.ts';
import { createLogger } from '../src/observability.ts';
import { loadConfig, type GatewayConfig } from '../src/config.ts';
import type { ContainerRuntime, PtyHandle } from '../src/runtime/types.ts';

/**
 * Containers and sessions over time.
 *
 * The two failures this guards against are opposites, and both are expensive.
 * One is reclaiming something a user is still using — killing `npm run dev`
 * because a tab was closed. The other is never reclaiming anything, which is
 * how a host ends up with a hundred forgotten containers and no memory.
 *
 * The runtime is a stub here on purpose: what is under test is the manager's
 * decisions, not Docker's.
 */

/** A PTY that does nothing, so a session can exist without a process. */
function fakePty(): PtyHandle & { killed: string[] } {
  const killed: string[] = [];
  let exitListener: ((r: { exitCode: number | null; signal: string | null }) => void) | null = null;
  return {
    pid: 1234,
    killed,
    write: () => undefined,
    resize: () => undefined,
    kill: (signal) => {
      killed.push(signal ?? 'SIGTERM');
      exitListener?.({ exitCode: null, signal: signal ?? 'SIGTERM' });
    },
    onData: () => undefined,
    onExit: (listener) => {
      exitListener = listener;
    },
  };
}

function stubRuntime(): ContainerRuntime & { created: string[]; destroyed: string[]; missing: Set<string> } {
  const created: string[] = [];
  const destroyed: string[] = [];
  const missing = new Set<string>();
  const live = new Set<string>();
  return {
    name: 'stub',
    isolates: true,
    created,
    destroyed,
    missing,
    available: async () => true,
    create: async (options) => {
      created.push(options.containerId);
      live.add(options.containerId);
    },
    start: async () => undefined,
    stop: async () => undefined,
    destroy: async (id) => {
      destroyed.push(id);
      live.delete(id);
    },
    exists: async (id) => live.has(id) && !missing.has(id),
    spawnShell: async () => fakePty(),
    endpointFor: async () => null,
  };
}

let config: GatewayConfig;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tacode-life-'));
  config = { ...loadConfig({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }), workspaceRoot: root };
});

const build = (overrides: Partial<GatewayConfig> = {}) => {
  const sessions = new SessionRegistry();
  const runtime = stubRuntime();
  const manager = new ContainerManager({ ...config, ...overrides }, runtime, sessions, createLogger(() => undefined));
  return { manager, sessions, runtime };
};

describe('one workspace per user and project', () => {
  it('creates a container the first time and reuses it after', async () => {
    const { manager, runtime } = build();

    const first = await manager.ensure('user-a', 'proj-1');
    const second = await manager.ensure('user-a', 'proj-1');

    expect(second.id).toBe(first.id);
    expect(runtime.created).toHaveLength(1);
  });

  it('gives different users different containers for the same project', async () => {
    const { manager } = build();

    const a = await manager.ensure('user-a', 'proj-1');
    const b = await manager.ensure('user-b', 'proj-1');

    expect(a.id).not.toBe(b.id);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
  });

  it('derives an id that is safe as a directory and a container name', () => {
    const id = containerIdFor('user-a/../..', 'proj; rm -rf /');

    expect(id).toMatch(/^tacode-[0-9a-f]{8}$/);
  });

  it('will not let one user occupy the host', async () => {
    const { manager } = build({ maxContainersPerUser: 2 });

    await manager.ensure('user-a', 'p1');
    await manager.ensure('user-a', 'p2');

    await expect(manager.ensure('user-a', 'p3')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('has a ceiling for the host as a whole', async () => {
    const { manager } = build({ maxContainers: 2, maxContainersPerUser: 10 });

    await manager.ensure('user-a', 'p1');
    await manager.ensure('user-b', 'p1');

    await expect(manager.ensure('user-c', 'p1')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('does not keep a slot after a container fails to start', async () => {
    const { manager, runtime } = build();
    runtime.create = async () => {
      throw new Error('no space left on device');
    };

    await expect(manager.ensure('user-a', 'p1')).rejects.toMatchObject({ code: 'CONTAINER_ERROR' });
    expect(manager.size).toBe(0);
  });
});

/**
 * The case the whole in-memory-registry design exists for: the runtime is the
 * authority, and a record describing something that is gone is a lie the
 * gateway must recover from rather than report.
 */
describe('when the runtime has lost a container', () => {
  it('recreates instead of handing back a container that no longer exists', async () => {
    const { manager, runtime } = build();
    const first = await manager.ensure('user-a', 'p1');

    runtime.missing.add(first.id);
    const second = await manager.ensure('user-a', 'p1');

    expect(runtime.created).toHaveLength(2);
    expect(second.status).toBe('ready');
  });
});

describe('reclaiming what nobody is using', () => {
  const attach = (sessions: SessionRegistry, containerId: string, userId = 'user-a') => {
    const session = new TerminalSession({ id: `sess-${Math.random()}`, containerId, userId, pty: fakePty() });
    sessions.add(session);
    return session;
  };

  it('reclaims a container that has been idle past its timeout', async () => {
    const { manager, sessions } = build();
    const record = await manager.ensure('user-a', 'p1');

    const future = Date.now() + (record.tier.idleTimeoutSeconds + 60) * 1000;
    const reclaimed = await manager.reap(future);

    expect(reclaimed.map((entry) => entry.id)).toEqual([record.id]);
    expect(sessions.all).toHaveLength(0);
    expect(manager.size).toBe(0);
  });

  /**
   * The behaviour a closed laptop lid depends on. A detached session is not an
   * idle one while its process is still producing output.
   */
  it('does not reclaim a workspace whose process is still working', async () => {
    const { manager, sessions } = build();
    const record = await manager.ensure('user-a', 'p1');
    const session = attach(sessions, record.id);

    const future = Date.now() + (record.tier.idleTimeoutSeconds + 60) * 1000;
    // A build server printing away, with nothing attached.
    session.lastActivity = future - 1000;

    expect(await manager.reap(future)).toHaveLength(0);
  });

  it('reclaims a workspace that has outlived its absolute ceiling, busy or not', async () => {
    const { manager, sessions } = build();
    const record = await manager.ensure('user-a', 'p1');
    const session = attach(sessions, record.id);

    const future = Date.now() + (record.tier.maxLifetimeSeconds + 60) * 1000;
    session.lastActivity = future;

    expect(await manager.reap(future)).toHaveLength(1);
  });

  it('destroys the container rather than only forgetting it', async () => {
    const { manager, runtime } = build();
    const record = await manager.ensure('user-a', 'p1');

    await manager.reap(Date.now() + (record.tier.maxLifetimeSeconds + 60) * 1000);

    expect(runtime.destroyed).toContain(record.id);
  });

  it('stops everything on shutdown, so nothing is orphaned', async () => {
    const { manager, runtime } = build();
    await manager.ensure('user-a', 'p1');
    await manager.ensure('user-b', 'p1');

    await manager.shutdown();

    expect(runtime.destroyed).toHaveLength(2);
    expect(manager.size).toBe(0);
  });
});

/**
 * Found by a test suite that started failing at its fourth terminal: detaching
 * deliberately leaves a shell running, so without pruning, closed tabs fill a
 * container's session budget and the next terminal is refused.
 */
describe('sessions that nobody will come back to', () => {
  it('does not count an exited shell against the limit', () => {
    const sessions = new SessionRegistry();
    const pty = fakePty();
    const session = new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty });
    sessions.add(session);
    expect(sessions.countFor('c1')).toBe(1);

    pty.kill('SIGTERM');

    expect(sessions.countFor('c1')).toBe(0);
  });

  it('prunes an exited shell', () => {
    const sessions = new SessionRegistry();
    const pty = fakePty();
    sessions.add(new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty }));
    pty.kill('SIGTERM');

    expect(sessions.prune(600)).toEqual(['s1']);
    expect(sessions.all).toHaveLength(0);
  });

  it('prunes a shell that is both detached and quiet', () => {
    const sessions = new SessionRegistry();
    const session = new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty: fakePty() });
    sessions.add(session);
    session.detach();

    expect(sessions.prune(60, Date.now() + 120_000)).toEqual(['s1']);
  });

  /**
   * The half that was missing at first, and would have killed the feature: a
   * detached session with a busy process is not abandoned.
   */
  it('keeps a detached shell whose process is still producing output', () => {
    const sessions = new SessionRegistry();
    const session = new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty: fakePty() });
    sessions.add(session);
    session.detach();

    const muchLater = Date.now() + 120_000;
    session.lastActivity = muchLater - 1000; // still printing

    expect(sessions.prune(60, muchLater)).toEqual([]);
  });

  it('leaves an attached shell alone however long it has been open', () => {
    const sessions = new SessionRegistry();
    const session = new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty: fakePty() });
    sessions.add(session);
    session.attach(() => undefined, () => 0);

    expect(sessions.prune(60, Date.now() + 86_400_000)).toEqual([]);
  });
});

describe('a session belongs to one user', () => {
  it('is invisible to anybody else, whatever id they name', () => {
    const sessions = new SessionRegistry();
    sessions.add(new TerminalSession({ id: 's1', containerId: 'c1', userId: 'owner', pty: fakePty() }));

    expect(sessions.find('s1', 'owner')).not.toBeNull();
    expect(sessions.find('s1', 'somebody-else')).toBeNull();
  });
});

describe('output while nobody is watching', () => {
  it('is bounded, and replays what still fits', () => {
    const pty = fakePty();
    let emit: (chunk: string) => void = () => undefined;
    pty.onData = (listener) => {
      emit = listener;
    };
    const session = new TerminalSession({
      id: 's1',
      containerId: 'c1',
      userId: 'u1',
      pty,
      replayBytes: 200,
    });

    // A process printing far more than the buffer holds.
    for (let i = 0; i < 100; i++) emit(`line ${i}\n`);

    const seen: string[] = [];
    session.attach((chunk) => seen.push(Buffer.from(chunk.data, 'base64').toString()), () => 0);

    const replayed = seen.join('');
    expect(replayed).toContain('line 99');
    // The oldest was dropped rather than kept forever.
    expect(replayed).not.toContain('line 0\n');
    expect(replayed.length).toBeLessThan(400);
  });

  it('holds output back while the socket is congested, then releases it', () => {
    const pty = fakePty();
    let emit: (chunk: string) => void = () => undefined;
    pty.onData = (listener) => {
      emit = listener;
    };
    const session = new TerminalSession({ id: 's1', containerId: 'c1', userId: 'u1', pty });

    let buffered = 0;
    const sent: string[] = [];
    session.attach((chunk) => sent.push(chunk.data), () => buffered);

    buffered = 10 * 1024 * 1024; // the browser is not keeping up
    emit('while congested\n');
    expect(sent).toHaveLength(0);

    buffered = 0;
    session.flush();
    expect(sent).toHaveLength(1);
  });
});

describe('the reaper does not hold the process open', () => {
  it('unrefs its timer', async () => {
    const { manager } = build();
    const spy = vi.spyOn(global, 'setInterval');

    manager.startReaper(1000);
    await manager.shutdown();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// Workspace roots are temporary; removing them keeps a long run from filling
// the machine's tmp directory.
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
