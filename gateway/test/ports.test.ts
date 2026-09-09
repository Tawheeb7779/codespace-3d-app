import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { createLocalRuntime } from '../src/runtime/local.ts';
import { createLogger } from '../src/observability.ts';
import { parseProxyPath } from '../src/ports.ts';
import type { Authorizer, ProjectRole } from '../src/auth.ts';
import { authError } from '../src/errors.ts';
import { PROTOCOL_VERSION, parseServerFrame, type ServerFrame } from '../../src/lib/terminal/protocol.ts';
import { loadPty } from '../src/runtime/pty.ts';

/**
 * Reaching a development server through the gateway.
 *
 * A real HTTP server plays the part of `npm run dev`, including a WebSocket
 * endpoint of the kind every hot-reloading bundler opens. The proxy in front of
 * it is the real one, and every request goes through the real authorisation
 * path — which is the point of the feature: a preview URL is not a capability,
 * it is a request that gets authorised like any other.
 */

const PROJECT = 'proj-alpha';
const ACCOUNTS: Record<string, { userId: string; roles: Record<string, ProjectRole> }> = {
  'token-amina': { userId: 'user-amina', roles: { [PROJECT]: 'owner' } },
  'token-bilal': { userId: 'user-bilal', roles: { 'proj-beta': 'owner' } },
};

const authorizer: Authorizer = {
  async identify(token) {
    const account = ACCOUNTS[token];
    if (!account) throw authError();
    return { userId: account.userId, email: 'x@example.test' };
  },
  async roleOn(userId, projectId) {
    return Object.values(ACCOUNTS).find((a) => a.userId === userId)?.roles[projectId] ?? null;
  },
};

let devServer: Server;
let devPort: number;
let gateway: ReturnType<typeof createGateway>;
let base: string;
let root: string;
let containerId: string;

beforeAll(async () => {
  await loadPty();

  // The stand-in development server: one route, and a WebSocket for "HMR".
  devServer = createServer((request, response) => {
    if (request.url === '/slow-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.end('data: two\n\n'), 50);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<html><body>dev server saw ${request.method} ${request.url}</body></html>`);
  });
  const hmr = new WebSocketServer({ server: devServer, path: '/hmr' });
  hmr.on('connection', (socket) => {
    socket.on('message', (raw) => socket.send(`echo:${String(raw)}`));
    socket.send('hmr-connected');
  });
  await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
  devPort = (devServer.address() as AddressInfo).port;

  root = await mkdtemp(join(tmpdir(), 'tacode-ports-'));
  const config = {
    ...loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    runtime: 'local' as const,
    workspaceRoot: root,
    // The dev server is on an ephemeral port, so the allowlist has to include it.
    allowedPorts: [devPort, 5173],
  };
  gateway = createGateway({
    config,
    runtime: createLocalRuntime(),
    authorizer,
    logger: createLogger(() => undefined),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, resolve));
  const port = (gateway.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  // A container has to exist before anything can be proxied to it, and it
  // exists only because somebody opened a terminal — which is the real path.
  containerId = await openTerminal(`ws://127.0.0.1:${port}/terminal`);
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => devServer.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function openTerminal(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'http://localhost:5173' });
    const timer = setTimeout(() => reject(new Error('terminal did not become ready')), 10_000);
    socket.on('open', () =>
      socket.send(
        JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: 'token-amina', projectId: PROJECT }),
      ),
    );
    socket.on('message', (raw) => {
      let frame: ServerFrame;
      try {
        frame = parseServerFrame(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'ready') {
        clearTimeout(timer);
        resolve(frame.containerId);
      }
    });
    socket.on('error', reject);
  });
}

const proxyUrl = (port: number, path = '/', token = 'token-amina', id = containerId) =>
  `${base}/proxy/${id}/${port}${path}?access_token=${token}`;

describe('reaching a development server', () => {
  it('relays a request and its response', async () => {
    const response = await fetch(proxyUrl(devPort, '/index.html'));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('dev server saw GET /index.html');
  });

  it('relays a path with a query string, minus the access token', async () => {
    const response = await fetch(`${base}/proxy/${containerId}/${devPort}/page?a=1&access_token=token-amina`);

    const body = await response.text();
    expect(body).toContain('/page?a=1');
    // The user's session must not be handed to whatever they are running.
    expect(body).not.toContain('token-amina');
  });

  it('relays a POST, not only a GET', async () => {
    const response = await fetch(proxyUrl(devPort, '/submit'), {
      method: 'POST',
      body: 'hello',
      headers: { 'content-type': 'text/plain' },
    });

    expect(await response.text()).toContain('POST /submit');
  });

  it('relays a streamed response without waiting for the end of it', async () => {
    const response = await fetch(proxyUrl(devPort, '/slow-stream'));

    expect(await response.text()).toContain('data: one');
  });

  /**
   * Hot module reloading is a WebSocket. A proxy that only understands request
   * and response leaves every modern dev server half working.
   */
  it('relays a WebSocket upgrade, which is what hot reload rides on', async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${new URL(base).port}/proxy/${containerId}/${devPort}/hmr?access_token=token-amina`,
    );
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hmr message')), 8000);
      socket.on('message', (raw) => {
        messages.push(String(raw));
        if (messages.length === 1) socket.send('ping-from-browser');
        if (messages.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on('error', reject);
    });

    expect(messages[0]).toBe('hmr-connected');
    expect(messages[1]).toBe('echo:ping-from-browser');
    socket.close();
  });
});

describe('who may reach it', () => {
  it('refuses a request with no token', async () => {
    const response = await fetch(`${base}/proxy/${containerId}/${devPort}/`);

    expect(response.status).toBe(403);
  });

  it('refuses a token belonging to somebody else', async () => {
    const response = await fetch(proxyUrl(devPort, '/', 'token-bilal'));

    expect(response.status).toBe(403);
  });

  it('refuses a container the caller does not own', async () => {
    const response = await fetch(proxyUrl(devPort, '/', 'token-amina', 'tacode-someone-else'));

    expect(response.status).toBe(403);
  });

  it('refuses a port that is not on the allowlist', async () => {
    const response = await fetch(proxyUrl(9999, '/'));

    expect(response.status).toBe(403);
  });

  /**
   * One message for every refusal, so the proxy cannot be used to discover
   * which containers or ports exist.
   */
  it('answers every refusal identically', async () => {
    const bodies = await Promise.all(
      [
        fetch(`${base}/proxy/${containerId}/${devPort}/`),
        fetch(proxyUrl(devPort, '/', 'token-bilal')),
        fetch(proxyUrl(9999, '/')),
        fetch(proxyUrl(devPort, '/', 'token-amina', 'tacode-nope')),
      ].map(async (promise) => (await promise).text()),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it('refuses a WebSocket upgrade from an unauthorised caller', async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${new URL(base).port}/proxy/${containerId}/${devPort}/hmr?access_token=token-bilal`,
    );

    await expect(
      new Promise((_resolve, reject) => {
        socket.on('error', reject);
        socket.on('open', () => reject(new Error('the socket opened, which it must not')));
      }),
    ).rejects.toBeTruthy();
  });

  it('reports a closed port as a bad gateway rather than hanging', async () => {
    // 5173 is allowlisted, and nothing is listening on it.
    const response = await fetch(proxyUrl(5173, '/'));

    expect(response.status).toBe(502);
  });
});

describe('the proxy path itself', () => {
  it('reads a container, a port and the rest of the path', () => {
    expect(parseProxyPath('/proxy/tacode-abc/3000/a/b?x=1')).toEqual({
      containerId: 'tacode-abc',
      port: 3000,
      rest: '/a/b',
    });
  });

  it('defaults to the root when there is no path', () => {
    expect(parseProxyPath('/proxy/tacode-abc/3000')).toMatchObject({ rest: '/' });
  });

  it('refuses anything that is not a container id and a port', () => {
    for (const path of [
      '/proxy/../etc/3000/',
      '/proxy/a b/3000/',
      '/proxy/tacode-abc/0/',
      '/proxy/tacode-abc/99999/',
      '/proxy/tacode-abc/notaport/',
      '/terminal',
      '/health',
    ]) {
      expect(parseProxyPath(path), path).toBeNull();
    }
  });
});

describe('health', () => {
  it('reports the runtime and whether it isolates, and nothing about users', async () => {
    const response = await fetch(`${base}/health`);
    const body = await response.json();

    expect(body).toMatchObject({ ok: true, runtime: 'local', isolated: false });
    expect(JSON.stringify(body)).not.toContain('user-');
    expect(JSON.stringify(body)).not.toContain(PROJECT);
  });
});
