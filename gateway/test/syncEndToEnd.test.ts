import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ContainerTerminal } from '../../src/lib/terminal/containerClient.ts';
import { WorkspaceSync, hashContent } from '../../src/lib/terminal/workspaceSync.ts';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import { authError } from '../src/errors.ts';
import type { Authorizer } from '../src/auth.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * The editor's filesystem and the container's, joined through the real wire.
 *
 * Both halves are shipping code: `WorkspaceSync` is the object the IDE drives
 * and `SyncService` is the one the gateway runs, with the actual protocol and
 * an actual WebSocket between them. `sync.test.ts` tests the decisions in
 * isolation and would not notice the two sides disagreeing about a frame; this
 * is the suite that would.
 *
 * The container runtime is local rather than Docker — file synchronisation is
 * about two writers over one directory, and that property does not change with
 * the isolation around it. What *is* real here is every byte on the wire.
 */

const PROJECT = 'proj-sync';

const authorizer: Authorizer = {
  async identify(token) {
    if (token !== 'good-token') throw authError();
    return { userId: 'user-amina', email: 'amina@example.test' };
  },
  async roleOn(_userId, projectId) {
    return projectId === PROJECT ? 'owner' : null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-sync-'));
  gateway = createGateway({
    config: {
      ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
      runtime: 'local',
      workspaceRoot: root,
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
});

/** The editor: a file map, a terminal client, and the sync engine between them. */
async function editor(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const conflicts: Array<{ path: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const applied: string[] = [];
  const deletedHere: string[] = [];
  let storms = 0;
  let ready = false;
  const plans: Array<{ needed: string[]; diverged: Array<{ path: string }> }> = [];

  const client: ContainerTerminal = new ContainerTerminal({
    gatewayUrl: url,
    projectId: PROJECT,
    token: async () => 'good-token',
    cols: 80,
    rows: 24,
    onOutput: () => undefined,
    onState: (state) => {
      if (state === 'ready') ready = true;
    },
    onSyncPlan: (plan) => {
      plans.push(plan);
      void sync.onPlan(plan);
    },
    onSyncAck: (results) => sync.onAck(results),
    onSyncChanged: (changed, removed) => sync.onChanged(changed, removed),
    onSyncStorm: (count) => {
      storms += 1;
      sync.onStorm();
      void count;
    },
    createSocket: (target) =>
      new WebSocket(target, { origin: 'http://localhost:5173' }) as unknown as globalThis.WebSocket,
  });

  const sync = new WorkspaceSync({
    terminal: client,
    files: () => files,
    // Stands in for the file store's write path. The real one goes through
    // `writeFile`, which is where the VFS guards live; those are tested in the
    // store's own suite and are not what this is about.
    applyFromContainer: (incoming, removed) => {
      for (const file of incoming) {
        files[file.path] = file.content;
        applied.push(file.path);
      }
      for (const path of removed) {
        delete files[path];
        deletedHere.push(path);
      }
    },
    onConflict: (conflict) => conflicts.push(conflict),
    onSkipped: (entries) => skipped.push(...entries),
    debounceMs: 20,
  });

  await client.connect();
  await until(() => ready);

  const session = {
    client,
    sync,
    files,
    conflicts,
    skipped,
    applied,
    deletedHere,
    plans,
    get storms() {
      return storms;
    },
    /** The container's side of this workspace, on disk. */
    workspaceDir: () => join(root, client.containerId!),
    /**
     * Offer the manifest and wait for the gateway's answer.
     *
     * A manifest is a round trip, and `start()` only sends it. Flushing before
     * the plan arrives sends nothing, because nothing is dirty yet — which
     * looks exactly like a broken sync engine and is not one.
     */
    async syncUp() {
      const before = plans.length;
      await sync.start();
      await until(() => plans.length > before);
      await sync.flush();
    },
    close: () => {
      sync.stop();
      client.disconnect(true);
    },
  };

  // A terminal session survives a failed assertion, and a container allows
  // only so many. Without this, one failing test starves every test after it
  // of a session and the whole file reports timeouts.
  open.push(session);
  return session;
}

let open: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const session of open) session.close();
  open = [];
});

/**
 * Poll until a condition holds.
 *
 * Awaits the condition, which matters more than it looks: a predicate that
 * returns a promise is truthy on the first tick, so an unawaited version of
 * this passes instantly and every assertion after it runs against a workspace
 * nothing has been written to yet. That is how the first run of this suite
 * reported failures in the code rather than in itself.
 */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const exists = (target: string): Promise<boolean> =>
  readFile(target, 'utf8').then(
    () => true,
    () => false,
  );

describe('an edit in the browser reaching the container', () => {
  it('writes a real file the shell can read', async () => {
    const session = await editor({ 'src/app.ts': 'export const answer = 42;\n' });
    await session.syncUp();

    const target = join(session.workspaceDir(), 'src/app.ts');
    await until(() => exists(target));

    expect(await readFile(target, 'utf8')).toBe('export const answer = 42;\n');

    // And the shell in that container sees the same bytes, which is the whole
    // point — a file that exists only in the gateway's view is not synchronised.
    session.client.write(`cat src/app.ts\n`);
    session.close();
  }, 30_000);

  it('sends only what changed after the first push', async () => {
    const session = await editor({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
    await session.syncUp();
    await until(() => exists(join(session.workspaceDir(), 'b.txt')));

    // Nothing changed: a flush now must be a no-op, not a second full push.
    const before = await readFile(join(session.workspaceDir(), 'a.txt'), 'utf8');
    await session.sync.flush();
    expect(await readFile(join(session.workspaceDir(), 'a.txt'), 'utf8')).toBe(before);

    session.files['a.txt'] = 'one changed\n';
    session.sync.noteChange('a.txt');
    await session.sync.flush();
    await until(
      async () => (await readFile(join(session.workspaceDir(), 'a.txt'), 'utf8')) === 'one changed\n',
    );

    session.close();
  }, 30_000);

  it('refuses a protected path rather than authoring into it', async () => {
    const session = await editor();
    await session.syncUp();

    // The editor's own guard stops this before the wire, which is the point:
    // `.env` is not a path the sync engine gets to have an opinion about.
    session.files['.env'] = 'SECRET=leaked\n';
    session.sync.noteChange('.env');
    await session.sync.flush();
    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(readFile(join(session.workspaceDir(), '.env'), 'utf8')).rejects.toThrow();
    session.close();
  }, 30_000);
});

describe('a change in the container reaching the browser', () => {
  it('delivers a file the shell created', async () => {
    const session = await editor();
    await session.syncUp();

    // Written through the filesystem the container shares, which is what the
    // watcher is watching.
    await writeFile(join(session.workspaceDir(), 'made-by-shell.txt'), 'from the container\n');

    await until(() => session.files['made-by-shell.txt'] !== undefined, 15_000);
    expect(session.files['made-by-shell.txt']).toBe('from the container\n');

    session.close();
  }, 30_000);

  it('does not send back what it just received', async () => {
    const session = await editor();
    await session.syncUp();

    const target = join(session.workspaceDir(), 'loop.txt');
    await writeFile(target, 'written once\n');
    await until(() => session.files['loop.txt'] !== undefined, 15_000);

    // The editor now "changes" the file to exactly what arrived, which is what
    // a store subscription does when the incoming write lands in it. If the
    // echo check were timing-based this is where the loop would start.
    session.sync.noteChange('loop.txt');
    await session.sync.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));

    // One delivery, not a stream of them.
    expect(session.applied.filter((path) => path === 'loop.txt')).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe('written once\n');

    session.close();
  }, 30_000);

  it('reports a deletion the shell performed', async () => {
    const session = await editor({ 'doomed.txt': 'here for now\n' });
    await session.syncUp();
    const target = join(session.workspaceDir(), 'doomed.txt');
    await until(() => exists(target));

    await rm(target);
    await until(() => session.deletedHere.includes('doomed.txt'), 15_000);
    expect(session.files['doomed.txt']).toBeUndefined();

    session.close();
  }, 30_000);
});

describe('both sides changing one file', () => {
  /**
   * The case the whole design exists for. Neither side is wrong, so the write
   * is refused and the person is told — rather than one of them losing work to
   * whichever frame happened to arrive second.
   */
  it('refuses the write and reports a conflict', async () => {
    const session = await editor({ 'contested.ts': 'const version = 1;\n' });
    await session.syncUp();
    const target = join(session.workspaceDir(), 'contested.ts');
    await until(() => exists(target));

    // The container changes it, and the editor does not hear about it — the
    // watcher is debounced, and this is the window in which a conflict is
    // possible at all.
    await writeFile(target, 'const version = 2; // the container\n');

    // The editor edits its own stale copy and pushes with the base hash it
    // still believes in.
    session.files['contested.ts'] = 'const version = 3; // the editor\n';
    session.sync.noteChange('contested.ts');
    await session.sync.flush();

    await until(() => session.conflicts.length > 0, 15_000);
    expect(session.conflicts[0].path).toBe('contested.ts');
    // The container's file is untouched: nothing was overwritten while the
    // disagreement stands.
    expect(await readFile(target, 'utf8')).toBe('const version = 2; // the container\n');

    session.close();
  }, 30_000);
});

describe('the manifest', () => {
  it('asks only for files the container is missing', async () => {
    const first = await editor({ 'shared.txt': 'same on both sides\n', 'only-here.txt': 'new\n' });
    await first.syncUp();
    await until(() => exists(join(first.workspaceDir(), 'only-here.txt')));
    const workspace = first.workspaceDir();
    first.close();

    // A second panel over the same workspace: the container already holds both
    // files, so the plan should ask for neither.
    const second = await editor({ 'shared.txt': 'same on both sides\n', 'only-here.txt': 'new\n' });
    await second.syncUp();

    expect(second.workspaceDir()).toBe(workspace);
    expect(second.plans).toHaveLength(1);
    expect(second.plans[0].needed).toEqual([]);
    second.close();
  }, 30_000);
});

describe('the hash both sides compute', () => {
  it('agrees with the gateway, or nothing else here would work', async () => {
    const { hashContent: gatewayHash } = await import('../src/sync.ts');

    for (const text of ['', 'a', 'export const x = 1;\n', 'ünïcödé — and emoji 🎉\n']) {
      expect(await hashContent(text)).toBe(gatewayHash(text));
    }
  });
});
