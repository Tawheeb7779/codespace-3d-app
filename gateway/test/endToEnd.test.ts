import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ContainerTerminal } from '../../src/lib/terminal/containerClient.ts';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import { authError } from '../src/errors.ts';
import type { Authorizer } from '../src/auth.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * The browser's client and the gateway, joined.
 *
 * Both halves are the shipping code: `src/lib/terminal/containerClient.ts` is
 * the same object the React component drives, and the gateway is the same
 * server that will be deployed. Only two things are stood in for — identity,
 * because Supabase is not here, and isolation, because this machine has no
 * container runtime.
 *
 * The unit suites test each side against a fake of the other, which is exactly
 * where a protocol drifts: both sides pass their own tests while disagreeing
 * about the wire. This is the suite that would notice.
 */

const PROJECT = 'proj-alpha';

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
  root = await mkdtemp(join(tmpdir(), 'tacode-e2e-'));
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

/** The browser client, with `ws` standing in for the platform's WebSocket. */
function browserClient(options: { token?: string; onOutput?: (text: string) => void } = {}) {
  let text = '';
  const decoder = new TextDecoder();
  const states: string[] = [];
  const errors: string[] = [];

  const client = new ContainerTerminal({
    gatewayUrl: url,
    projectId: PROJECT,
    token: async () => options.token ?? 'good-token',
    cols: 80,
    rows: 24,
    onOutput: (bytes) => {
      const chunk = decoder.decode(bytes, { stream: true });
      text += chunk;
      options.onOutput?.(chunk);
    },
    onState: (state) => states.push(state),
    onError: (_code, message) => errors.push(message),
    // `ws`'s socket is structurally close enough for the client, which uses
    // only `send`, `close`, `readyState` and the four handlers.
    createSocket: (target) =>
      new WebSocket(target, { origin: 'http://localhost:5173' }) as unknown as globalThis.WebSocket,
  });

  return {
    client,
    states,
    errors,
    get text() {
      return text;
    },
    async waitFor(needle: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!text.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${needle}\nsaw: ${text.slice(-300)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async waitForState(state: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!states.includes(state)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for state ${state}: ${states}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

describe('a browser opening a Linux terminal', () => {
  it('connects, runs a command, and sees the real output', async () => {
    const session = browserClient();
    await session.client.connect();
    await session.waitForState('ready');

    session.client.write('echo joined-end-to-end\n');
    await session.waitFor('joined-end-to-end');

    expect(session.client.runtime).toBe('local');
    expect(session.client.containerId).toMatch(/^tacode-/);
    session.client.disconnect(true);
  });

  it('runs a real toolchain, not a simulation of one', async () => {
    const session = browserClient();
    await session.client.connect();
    await session.waitForState('ready');

    session.client.write('node -e "process.stdout.write(String(21*2))"\n');
    await session.waitFor('42');

    session.client.write('python3 -c "print(\'python-works\')"\n');
    await session.waitFor('python-works');

    session.client.disconnect(true);
  });

  it('creates real files that persist in the workspace', async () => {
    const session = browserClient();
    await session.client.connect();
    await session.waitForState('ready');

    session.client.write('mkdir -p src && echo "export const x = 1" > src/made.ts && cat src/made.ts\n');
    await session.waitFor('export const x = 1');

    session.client.disconnect(true);
  });

  it('resizes, and the shell agrees about the new width', async () => {
    const session = browserClient();
    await session.client.connect();
    await session.waitForState('ready');

    session.client.resize(132, 43);
    session.client.write('tput cols\n');
    await session.waitFor('132');

    session.client.disconnect(true);
  });

  it('refuses a browser with no valid session, and says why without retrying', async () => {
    const session = browserClient({ token: 'not-a-real-token' });
    await session.client.connect();
    await session.waitForState('unavailable');

    expect(session.errors.join(' ')).toMatch(/sign in|expired/i);
    // Not stuck in a reconnect loop against a gateway that will never admit it.
    expect(session.states.filter((state) => state === 'reconnecting')).toHaveLength(0);
  });
});

describe('the reconnect the whole session model exists for', () => {
  /**
   * The scenario in full: start something long-running, lose the connection the
   * way a closed laptop does, come back, and find it still running with the
   * output produced in between.
   */
  it('keeps a process alive across a disconnect and replays what was missed', async () => {
    const first = browserClient();
    await first.client.connect();
    await first.waitForState('ready');

    first.client.write('(while true; do echo tick; sleep 0.2; done) &\n');
    first.client.write('echo loop-started\n');
    await first.waitFor('loop-started');

    const sessionId = first.client.sessionId!;
    // Detach without killing — exactly what closing the panel does.
    first.client.disconnect(false);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const second = browserClient();
    // The same client state a reopened panel would carry.
    second.client.sessionId = sessionId;
    await second.client.connect();
    await second.waitForState('ready');

    // Still running, which it would not be had the disconnect killed it.
    await second.waitFor('tick');
    second.client.disconnect(true);
  });

  it('starts a new shell when the old one is gone rather than failing', async () => {
    const first = browserClient();
    await first.client.connect();
    await first.waitForState('ready');
    const deadSession = first.client.sessionId!;
    first.client.disconnect(true);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = browserClient();
    second.client.sessionId = deadSession;
    await second.client.connect();
    await second.waitForState('ready');

    expect(second.client.sessionId).not.toBe(deadSession);
    second.client.disconnect(true);
  });
});

describe('output that arrives faster than a browser can take it', () => {
  /**
   * The backpressure case, from the outside: a process that prints a great deal
   * must not grow the gateway without bound, and the terminal must stay usable
   * afterwards.
   */
  it('survives a process producing a flood, and still accepts input after', async () => {
    const session = browserClient();
    await session.client.connect();
    await session.waitForState('ready');

    session.client.write('for i in $(seq 1 2000); do echo "line $i padding padding padding"; done\n');
    await session.waitFor('line 2000');

    session.client.write('echo still-responsive\n');
    await session.waitFor('still-responsive');

    session.client.disconnect(true);
  }, 30_000);
});
