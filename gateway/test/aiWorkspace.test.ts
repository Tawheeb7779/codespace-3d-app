import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * The agent's verification path, end to end, with a real script.
 *
 * `checks.test.ts` proves the allowlist and the shape of the request against a
 * recording runtime. This runs the whole thing — a real `npm run` in a real
 * workspace, over the real protocol, through the real authorisation path — so a
 * passing check here means the agent could genuinely verify its own work rather
 * than that the pieces agree with their own fakes.
 *
 * The runtime is local, which is what makes `npm` available; the Docker path
 * for `runCommand` is proven by the twenty-four real-container git tests that
 * use the same primitive.
 */

const PROJECT = 'proj-alpha';

const ACCOUNTS: Record<string, { userId: string; roles: Record<string, ProjectRole> }> = {
  'token-amina': { userId: 'user-amina', roles: { [PROJECT]: 'owner' } },
  'token-bilal': { userId: 'user-bilal', roles: {} },
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

interface Client {
  frames: Array<Record<string, unknown>>;
  wait: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  send: (frame: unknown) => void;
  close: () => void;
}

let opened: Client[] = [];

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-ai-'));
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
}, 60_000);

afterAll(async () => {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
});

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
    frames,
    async wait(type, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find((frame) => frame.type === type);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`no ${type}; saw ${frames.map((f) => f.type).join(',')}`);
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

async function attach(token = 'token-amina'): Promise<{ client: Client; containerId: string }> {
  const client = await open();
  client.send({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token,
    projectId: PROJECT,
    kind: 'project',
    cols: 80,
    rows: 24,
  });
  const ready = await client.wait('ready');
  return { client, containerId: String(ready.containerId) };
}

/** Put a manifest with real scripts into the workspace the container uses. */
async function seedProject(containerId: string, scripts: Record<string, string>): Promise<void> {
  await writeFile(
    join(root, containerId, 'package.json'),
    JSON.stringify({ name: 'seeded', private: true, scripts }, null, 2),
  );
}

describe('the agent asking what it can verify with', () => {
  it('reports the checks this project actually defines', async () => {
    const { client, containerId } = await attach();
    await seedProject(containerId, {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      dev: 'vite',
    });

    client.send({ type: 'check', requestId: 'c1', containerId, request: { op: 'list' } });
    const answer = await client.wait('check-result');

    expect(answer.ok).toBe(true);
    expect(answer.available).toEqual(['test', 'lint']);
  }, 60_000);

  /**
   * The workspace persists across connections — that is the feature — so the
   * manifest is removed rather than a fresh container assumed.
   */
  it('reports none for a project with no manifest', async () => {
    const { client, containerId } = await attach();
    await rm(join(root, containerId, 'package.json'), { force: true });

    client.send({ type: 'check', requestId: 'c2', containerId, request: { op: 'list' } });
    const answer = await client.wait('check-result');

    expect(answer.available).toEqual([]);
  }, 60_000);
});

describe('the agent running a real check', () => {
  /**
   * A real `npm run`, a real Node process, a real exit code. This is the
   * difference between the agent saying "it builds" from the in-browser bundler
   * and saying "the tests pass" because they were executed.
   */
  it('runs a passing script and reports it passed', async () => {
    const { client, containerId } = await attach();
    await seedProject(containerId, {
      test: 'node -e "console.log(\'42 tests passed\')"',
    });

    client.send({
      type: 'check',
      requestId: 'run-pass',
      containerId,
      request: { op: 'run', script: 'test' },
    });
    const answer = await client.wait('check-result', 120_000);

    expect(answer.ok).toBe(true);
    const result = answer.result as { ok: boolean; exitCode: number; output: string };
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('42 tests passed');
  }, 180_000);

  /**
   * The case that matters most for honesty: the agent must receive the failure
   * and its output, not an error that hides them.
   */
  it('runs a failing script and reports the failure with its output', async () => {
    const { client, containerId } = await attach();
    await seedProject(containerId, {
      test: 'node -e "console.log(\'expected 2 to be 3\'); process.exit(1)"',
    });

    client.send({
      type: 'check',
      requestId: 'run-fail',
      containerId,
      request: { op: 'run', script: 'test' },
    });
    const answer = await client.wait('check-result', 120_000);

    // The *request* succeeded; the check did not.
    expect(answer.ok).toBe(true);
    const result = answer.result as { ok: boolean; exitCode: number; output: string };
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('expected 2 to be 3');
  }, 180_000);

  it('refuses a script outside the allowlist even when the project defines it', async () => {
    const { client, containerId } = await attach();
    await seedProject(containerId, { deploy: 'node -e "console.log(\'shipped\')"' });

    client.send({
      type: 'check',
      requestId: 'run-deploy',
      containerId,
      // The protocol accepts the name's shape; the gateway's allowlist refuses it.
      request: { op: 'run', script: 'deploy' },
    });
    const answer = await client.wait('check-result');

    expect(answer.ok).toBe(false);
    expect(String(answer.message)).toMatch(/not a check/i);
  }, 60_000);

  it('refuses an allowed name the project does not define', async () => {
    const { client, containerId } = await attach();
    await seedProject(containerId, { test: 'node -e ""' });

    client.send({
      type: 'check',
      requestId: 'run-missing',
      containerId,
      request: { op: 'run', script: 'lint' },
    });
    const answer = await client.wait('check-result');

    expect(answer.ok).toBe(false);
    expect(String(answer.message)).toMatch(/does not define/i);
  }, 60_000);

  it.each(['../evil', 'test;rm -rf /', 'test && curl x', 'TEST', '-rf'])(
    'refuses the malformed script name %j at the protocol boundary',
    async (script) => {
      const { client, containerId } = await attach();

      client.send({
        type: 'check',
        requestId: 'run-bad',
        containerId,
        request: { op: 'run', script },
      });
      const error = await client.wait('error');

      expect(error.code).toBe('PROTOCOL_ERROR');
    },
    60_000,
  );
});

describe('who may ask a workspace to run a check', () => {
  it('refuses a caller who does not own the container', async () => {
    const mine = await attach('token-amina');

    const theirs = await open();
    theirs.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'token-bilal',
      projectId: '',
      kind: 'linux',
    });
    await theirs.wait('ready');

    theirs.send({
      type: 'check',
      requestId: 'cross',
      containerId: mine.containerId,
      request: { op: 'run', script: 'test' },
    });
    const error = await theirs.wait('error');

    expect(error.code).toBe('PERMISSION_ERROR');
    expect(theirs.frames.find((frame) => frame.type === 'check-result')).toBeUndefined();
  }, 60_000);

  it('refuses an unauthenticated socket outright', async () => {
    const client = await open();

    client.send({
      type: 'check',
      requestId: 'anon',
      containerId: 'tacode-' + 'a'.repeat(32),
      request: { op: 'list' },
    });
    const error = await client.wait('error');

    expect(error.code).toBe('AUTH_ERROR');
  }, 60_000);
});
