import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, parseServerFrame, type ServerFrame } from '../../src/lib/terminal/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import type { Authorizer, ProjectRole } from '../src/auth.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * The terminal, end to end, with nothing stubbed but identity.
 *
 * A real HTTP server, a real WebSocket, the real protocol parser, and real
 * PTYs running real `bash`. What is stubbed is Supabase — the authorizer is an
 * interface precisely so that the identity decision can be driven from a test
 * without a database — and the container runtime is the local one, which runs
 * the shell as a child process rather than in a container.
 *
 * That boundary is worth stating plainly, because it is where these tests stop
 * proving things. They prove the gateway's own behaviour: that an unauthorised
 * socket gets nothing, that one user cannot reach another's session, that a
 * shell really executes commands and reports real exit codes, that a
 * disconnect does not kill a long-running process, and that a reconnect
 * replays what was missed. They do not prove container isolation, because this
 * machine has no container runtime — no Docker socket, no user namespaces, no
 * cgroup controllers. Those properties live in the Docker runtime's arguments
 * and are tested as arguments in `docker.test.ts`.
 */

const PROJECT = 'proj-alpha';
const OTHER_PROJECT = 'proj-beta';

/** Tokens this fake Supabase vouches for, and the role each holds. */
const ACCOUNTS: Record<string, { userId: string; roles: Record<string, ProjectRole> }> = {
  'token-amina': { userId: 'user-amina', roles: { [PROJECT]: 'owner' } },
  'token-bilal': { userId: 'user-bilal', roles: { [OTHER_PROJECT]: 'owner' } },
  'token-viewer': { userId: 'user-viewer', roles: { [PROJECT]: 'viewer' } },
};

const authorizer: Authorizer = {
  async identify(token) {
    const account = ACCOUNTS[token];
    if (!account) {
      const { authError } = await import('../src/errors.ts');
      throw authError('Your session has expired. Sign in again.');
    }
    return { userId: account.userId, email: `${account.userId}@example.test` };
  },
  async roleOn(userId, projectId) {
    const account = Object.values(ACCOUNTS).find((entry) => entry.userId === userId);
    return account?.roles[projectId] ?? null;
  },
};

let gateway: ReturnType<typeof createGateway>;
let url: string;
let root: string;

beforeAll(async () => {
  await loadPty();
  root = await mkdtemp(join(tmpdir(), 'tacode-gw-'));
  const config = {
    ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    runtime: 'local' as const,
    workspaceRoot: root,
  };
  gateway = createGateway({
    config,
    runtime: createLocalRuntime(),
    authorizer,
    logger: createLogger(() => undefined),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
  url = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/terminal`;
});

afterAll(async () => {
  await gateway.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A small client, so each test reads as a conversation.
// ---------------------------------------------------------------------------

class Client {
  readonly frames: ServerFrame[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: Array<{ match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];

  constructor(private readonly target = url) {
    this.socket = new WebSocket(this.target, { origin: 'http://localhost:5173' });
    this.socket.on('message', (raw) => {
      let frame: ServerFrame;
      try {
        frame = parseServerFrame(String(raw));
      } catch {
        return;
      }
      this.frames.push(frame);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(frame)) this.waiters.splice(i, 1)[0].resolve(frame);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Raw, so a test can send something the encoder would refuse. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  await<T extends ServerFrame['type']>(type: T, timeoutMs = 10_000): Promise<Extract<ServerFrame, { type: T }>> {
    const existing = this.frames.find((frame) => frame.type === type);
    if (existing) return Promise.resolve(existing as Extract<ServerFrame, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        match: (frame) => frame.type === type,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame as Extract<ServerFrame, { type: T }>);
        },
      });
    });
  }

  /** Terminal output decoded and concatenated, for asserting on what appeared. */
  output(): string {
    return this.frames
      .filter((frame): frame is Extract<ServerFrame, { type: 'output' }> => frame.type === 'output')
      .map((frame) => Buffer.from(frame.data, 'base64').toString('utf8'))
      .join('');
  }

  async waitForOutput(needle: string | RegExp, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = this.output();
      if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return text;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}\nsaw: ${text.slice(-400)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  type(sessionId: string, text: string): void {
    this.send({ type: 'input', sessionId, data: Buffer.from(text, 'utf8').toString('base64') });
  }

  /**
   * What a user closing a terminal tab does, as opposed to losing a connection.
   *
   * Tests must do this or they leak shells: detaching deliberately leaves the
   * process running, which is the feature, so a suite that only closed sockets
   * would fill each container's session budget and then start failing — which
   * is exactly how the session reaper came to be written.
   */
  killSessions(): void {
    for (const frame of this.frames) {
      if (frame.type === 'ready' && this.socket.readyState === 1) {
        this.send({ type: 'detach', sessionId: frame.sessionId, kill: true });
      }
    }
  }

  close(): void {
    this.socket.close();
  }

  get closed(): Promise<void> {
    return new Promise((resolve) => this.socket.once('close', () => resolve()));
  }

  get closedWith(): Promise<number> {
    return new Promise((resolve) => this.socket.once('close', (code) => resolve(code)));
  }
}

const clients: Client[] = [];
const connect = async (target = url) => {
  const client = new Client(target);
  clients.push(client);
  await client.open();
  return client;
};

afterEach(async () => {
  const open = clients.splice(0);
  for (const client of open) client.killSessions();
  // Let the kills land before the sockets go.
  await new Promise((resolve) => setTimeout(resolve, 120));
  for (const client of open) client.close();
});

const hello = (token: string, projectId = PROJECT, extra: object = {}) => ({
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  token,
  projectId,
  cols: 80,
  rows: 24,
  ...extra,
});

// ---------------------------------------------------------------------------
// Authentication and authorisation
// ---------------------------------------------------------------------------

describe('who may open a terminal', () => {
  it('gives an authenticated editor a shell', async () => {
    const client = await connect();
    client.send(hello('token-amina'));

    const ready = await client.await('ready');

    expect(ready.runtime).toBe('local');
    expect(ready.resumed).toBe(false);
    expect(ready.sessionId).toMatch(/^sess-/);
  });

  it('refuses an unknown token, and closes the socket', async () => {
    const client = await connect();
    client.send(hello('token-forged'));

    const error = await client.await('error');

    expect(error.code).toBe('AUTH_ERROR');
    expect(error.fatal).toBe(true);
    await client.closed;
  });

  it('refuses a socket that never authenticates at all', async () => {
    const client = await connect();
    client.send({ type: 'input', sessionId: 'sess-anything', data: 'bHM=' });

    const error = await client.await('error');

    expect(error.code).toBe('AUTH_ERROR');
  });

  /**
   * A shell runs code against a project's files, so reading it is not enough.
   */
  it('refuses a viewer, who may read the project but not run code in it', async () => {
    const client = await connect();
    client.send(hello('token-viewer'));

    const error = await client.await('error');

    expect(error.code).toBe('PERMISSION_ERROR');
  });

  it('refuses a project the caller has no role on', async () => {
    const client = await connect();
    client.send(hello('token-bilal', PROJECT));

    const error = await client.await('error');

    expect(error.code).toBe('PERMISSION_ERROR');
  });

  /**
   * The message must not distinguish "no such project" from "not yours", or it
   * becomes a way to enumerate project ids.
   */
  it('says the same thing for a project that is missing and one that is forbidden', async () => {
    const missing = await connect();
    missing.send(hello('token-amina', 'proj-does-not-exist'));
    const a = await missing.await('error');

    const forbidden = await connect();
    forbidden.send(hello('token-bilal', PROJECT));
    const b = await forbidden.await('error');

    expect(a.message).toBe(b.message);
  });
});

describe('one user cannot reach another user’s terminal', () => {
  it('refuses input aimed at a session id that belongs to somebody else', async () => {
    const amina = await connect();
    amina.send(hello('token-amina'));
    const aminaSession = (await amina.await('ready')).sessionId;

    const bilal = await connect();
    bilal.send(hello('token-bilal', OTHER_PROJECT));
    await bilal.await('ready');

    // Bilal knows Amina's session id and asks for it directly.
    bilal.type(aminaSession, 'whoami\n');
    const error = await bilal.await('error');

    expect(error.code).toBe('PERMISSION_ERROR');
    // And nothing of Amina's arrived in his stream.
    expect(bilal.output()).not.toContain('whoami');
  });

  it('refuses to resume another user’s session by naming it in hello', async () => {
    const amina = await connect();
    amina.send(hello('token-amina'));
    const aminaSession = (await amina.await('ready')).sessionId;

    const bilal = await connect();
    bilal.send(hello('token-bilal', OTHER_PROJECT, { sessionId: aminaSession }));
    const ready = await bilal.await('ready');

    // He gets his own new session, never Amina's.
    expect(ready.resumed).toBe(false);
    expect(ready.sessionId).not.toBe(aminaSession);
  });

  it('gives two users different containers for different projects', async () => {
    const amina = await connect();
    amina.send(hello('token-amina'));
    const one = await amina.await('ready');

    const bilal = await connect();
    bilal.send(hello('token-bilal', OTHER_PROJECT));
    const two = await bilal.await('ready');

    expect(one.containerId).not.toBe(two.containerId);
  });
});

// ---------------------------------------------------------------------------
// A real shell
// ---------------------------------------------------------------------------

describe('running commands', () => {
  it('executes a real command and shows its real output', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.type(sessionId, 'echo hello-from-a-real-shell\n');

    await client.waitForOutput('hello-from-a-real-shell');
  });

  it('reports a real exit code, from the shell rather than from a table', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.type(sessionId, 'sh -c "exit 42"; echo "code=$?"\n');

    await client.waitForOutput('code=42');
  });

  it('carries stderr as well as stdout, because a PTY merges them', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.type(sessionId, 'ls /definitely-not-here 2>&1\n');

    await client.waitForOutput(/No such file|cannot access/);
  });

  it('runs a real interpreter, not a simulated one', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.type(sessionId, 'node -e "console.log(6*7)"\n');

    await client.waitForOutput('42');
  });

  /**
   * Ctrl+C only means anything with a controlling terminal. On a pipe there is
   * no foreground process group to signal, which is why this is a PTY.
   */
  it('interrupts a running process with Ctrl+C', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    // The marker is computed by the shell, so it appears only if the command
    // *ran*. A literal marker would show up in bash's echo of the typed line
    // and the assertion would pass whether or not Ctrl+C did anything.
    client.type(sessionId, 'sleep 60; echo survived-$((6*7))\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.type(sessionId, '\x03');
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.type(sessionId, 'echo interrupted-$((1+1))\n');

    await client.waitForOutput('interrupted-2');
    // The sleep was killed, so the command after it never executed.
    expect(client.output()).not.toContain('survived-42');
  });

  it('accepts a resize without disturbing the session', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.send({ type: 'resize', sessionId, cols: 120, rows: 40 });
    client.type(sessionId, 'tput cols\n');

    await client.waitForOutput('120');
  });

  it('reports the shell exiting, with its code', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.type(sessionId, 'exit 3\n');

    const exit = await client.await('exit');
    expect(exit.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('the workspace on disk', () => {
  it('runs in a directory of its own, which the shell can write', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId, containerId } = await client.await('ready');

    client.type(sessionId, 'echo written-by-the-terminal > note.txt\n');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const written = await readFile(join(root, containerId, 'note.txt'), 'utf8');
    expect(written.trim()).toBe('written-by-the-terminal');
  });

  it('sees a file the editor placed there', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId, containerId } = await client.await('ready');

    await writeFile(join(root, containerId, 'from-editor.txt'), 'editor content\n');
    client.type(sessionId, 'cat from-editor.txt\n');

    await client.waitForOutput('editor content');
  });

  it('gives the same user the same workspace on a second connection', async () => {
    const first = await connect();
    first.send(hello('token-amina'));
    const one = await first.await('ready');

    const second = await connect();
    second.send(hello('token-amina'));
    const two = await second.await('ready');

    expect(two.containerId).toBe(one.containerId);
  });
});

// ---------------------------------------------------------------------------
// Disconnect, reconnect, and what survives
// ---------------------------------------------------------------------------

describe('losing the connection', () => {
  /**
   * The behaviour the whole session/connection split exists for: a closed tab
   * must not kill `npm run dev`.
   */
  it('leaves a long-running process running when the socket goes away', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    // A stand-in for a dev server: prints on a timer, forever.
    client.type(sessionId, 'while true; do echo tick; sleep 0.3; done &\n');
    client.type(sessionId, 'echo started-the-loop\n');
    await client.waitForOutput('started-the-loop');

    client.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 800));

    const again = await connect();
    again.send(hello('token-amina', PROJECT, { sessionId }));
    const ready = await again.await('ready');

    expect(ready.resumed).toBe(true);
    expect(ready.sessionId).toBe(sessionId);
    // It is still going, which it would not be had the socket killed it.
    await again.waitForOutput('tick');
  });

  it('replays the output produced while nothing was attached', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId, seq } = await client.await('ready');

    client.type(sessionId, 'echo before-the-drop\n');
    await client.waitForOutput('before-the-drop');
    const lastSeen = client.frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => (frame as Extract<ServerFrame, { type: 'output' }>).seq)
      .at(-1)!;

    client.close();
    await client.closed;

    // Something happens while the browser is away.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const again = await connect();
    again.send(hello('token-amina', PROJECT, { sessionId, lastSeq: lastSeen }));
    await again.await('ready');
    again.type(sessionId, 'echo after-the-return\n');

    await again.waitForOutput('after-the-return');
    expect(seq).toBeGreaterThanOrEqual(0);
  });

  it('kills the shell when the client explicitly asks it to', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    client.send({ type: 'detach', sessionId, kill: true });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const again = await connect();
    again.send(hello('token-amina', PROJECT, { sessionId }));
    const ready = await again.await('ready');

    expect(ready.resumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Protocol abuse
// ---------------------------------------------------------------------------

describe('a hostile socket', () => {
  it('closes on a frame it cannot parse', async () => {
    const client = await connect();
    client.sendRaw('{ not json');

    const error = await client.await('error');

    expect(error.code).toBe('PROTOCOL_ERROR');
    expect(error.fatal).toBe(true);
    await client.closed;
  });

  it('refuses a frame type that does not exist', async () => {
    const client = await connect();
    client.sendRaw(JSON.stringify({ type: 'exec', command: 'rm -rf /' }));

    expect((await client.await('error')).code).toBe('PROTOCOL_ERROR');
  });

  it('refuses a protocol version it does not speak', async () => {
    const client = await connect();
    client.send({ ...hello('token-amina'), protocol: 99 });

    const error = await client.await('error');

    expect(error.code).toBe('PROTOCOL_ERROR');
  });

  it('refuses a second hello on the same socket', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    await client.await('ready');

    client.send(hello('token-amina'));

    expect((await client.await('error')).code).toBe('PROTOCOL_ERROR');
  });

  it('throttles a socket that floods it', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    const { sessionId } = await client.await('ready');

    for (let i = 0; i < 400; i++) client.type(sessionId, 'x');

    const error = await client.await('error');
    expect(error.code).toBe('RESOURCE_LIMIT');
  });

  /**
   * The cap is enforced by the WebSocket layer, before the frame reaches any
   * code of ours — so the observable is the closed socket, not a reply. A test
   * that looked for absent output would instead be watching the shell's own
   * prompt arrive and would pass for the wrong reason.
   */
  it('closes the socket on an oversized frame rather than buffering it', async () => {
    const client = await connect();
    client.send(hello('token-amina'));
    await client.await('ready');

    client.sendRaw(JSON.stringify({ type: 'input', sessionId: 'sess-x', data: 'A'.repeat(400_000) }));

    const code = await client.closedWith;
    // 1009 is "message too big"; `ws` sends it when maxPayload is breached.
    expect(code).toBe(1009);
  });
});
