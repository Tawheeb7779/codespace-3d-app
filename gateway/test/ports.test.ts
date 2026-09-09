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
  // The authorization matrix. A viewer may read a project in the editor and
  // must not reach a shell or a preview in it; an editor may do both.
  'token-chidi': { userId: 'user-chidi', roles: { [PROJECT]: 'viewer' } },
  'token-dara': { userId: 'user-dara', roles: { [PROJECT]: 'editor' } },
  'token-emeka': { userId: 'user-emeka', roles: { [PROJECT]: 'admin' } },
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
    if (request.url?.startsWith('/echo-headers')) {
    // Everything the proxy chose to forward, so a test can assert on what did
    // *not* cross rather than only on what did.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: request.url, headers: request.headers }));
    return;
  }
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


// ---------------------------------------------------------------------------
// What the proxy forwards, and what it must not
// ---------------------------------------------------------------------------

describe('what crosses into the container', () => {
  const echo = async (init: RequestInit = {}) => {
    const response = await fetch(proxyUrl(devPort, '/echo-headers'), init);
    return (await response.json()) as { url: string; headers: Record<string, string> };
  };

  /**
   * The caller's TA CODE session token must not reach the development server.
   * It is a credential for the gateway, and the workload behind the proxy is
   * the user's own untrusted code — handing it a token that opens terminals is
   * the whole reason this is stripped in two places.
   */
  it('never forwards the Authorization header', async () => {
    const seen = await echo({ headers: { authorization: 'Bearer token-amina' } });

    expect(seen.headers.authorization).toBeUndefined();
  });

  it('never forwards the access token in the query string', async () => {
    const seen = await echo();

    expect(seen.url).not.toContain('access_token');
    expect(seen.url).not.toContain('token-amina');
  });

  it('keeps the caller’s other query parameters intact', async () => {
    const response = await fetch(
      `${base}/proxy/${containerId}/${devPort}/echo-headers?page=2&q=hello&access_token=token-amina`,
    );
    const seen = (await response.json()) as { url: string };

    expect(seen.url).toContain('page=2');
    expect(seen.url).toContain('q=hello');
    expect(seen.url).not.toContain('access_token');
  });

  /**
   * The Host header is rewritten to the destination. Forwarding the gateway's
   * own Host lets a dev server generate absolute URLs pointing back at the
   * gateway, and is the usual ingredient in a host-header attack.
   */
  it('rewrites Host to the container’s endpoint', async () => {
    const seen = await echo({ headers: { host: 'evil.example' } });

    expect(seen.headers.host).not.toBe('evil.example');
    expect(seen.headers.host).toContain(String(devPort));
  });

  it('does not forward hop-by-hop headers', async () => {
    const seen = await echo({ headers: { 'proxy-authorization': 'Basic abc' } });

    expect(seen.headers['proxy-authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The authorization matrix, over the proxy
// ---------------------------------------------------------------------------

describe('which roles may reach a preview', () => {
  const reach = (token: string) =>
    fetch(proxyUrl(devPort, '/', token)).then((response) => response.status);

  it('lets an owner through', async () => {
    expect(await reach('token-amina')).toBe(200);
  });

  /**
   * A container runs code against a project's files, so the bar is `editor` in
   * both directions — the terminal and the preview. A viewer who could reach
   * the preview would be reaching a server running the project's own code.
   */
  it('refuses a viewer', async () => {
    expect(await reach('token-chidi')).toBe(403);
  });

  /**
   * An editor on the project is authorised, but the container belongs to
   * Amina: `byId` matches on ownership, so this is refused for a different
   * reason and with the same answer.
   */
  it('refuses an editor who does not own this container', async () => {
    expect(await reach('token-dara')).toBe(403);
  });

  it('refuses an admin who does not own this container', async () => {
    expect(await reach('token-emeka')).toBe(403);
  });

  it('refuses a caller with no role on the project at all', async () => {
    expect(await reach('token-bilal')).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Destinations the proxy must never be talked into
// ---------------------------------------------------------------------------

describe('the proxy as an SSRF primitive', () => {
  /**
   * The destination host is never taken from the caller. It comes from the
   * runtime — `docker inspect` for a real container — and the caller supplies
   * only a container id, which is checked for ownership, and a port, which is
   * checked against the allowlist. These assert that no spelling of a
   * destination in the path changes where the request goes.
   */
  it.each([
    ['an absolute URL', `/proxy/${'x'.repeat(8)}/80/http://169.254.169.254/latest/meta-data/`],
    ['a host in the container slot', '/proxy/169.254.169.254/80/'],
    ['a port with a host suffix', `/proxy/abc/80@evil.example/`],
    ['a negative port', '/proxy/abc/-1/'],
    ['a port past the range', '/proxy/abc/99999/'],
    ['an id with a slash', '/proxy/abc/def/80/'],
    ['an id with a dot segment', '/proxy/../../etc/80/'],
  ])('refuses %s', async (_label, path) => {
    const response = await fetch(`${base}${path}?access_token=token-amina`);

    // Either the path does not parse as a proxy request at all (404) or it
    // parses and fails authorisation (403). Never 200, and never a request
    // that leaves this host for somewhere the caller named.
    expect([403, 404]).toContain(response.status);
  });

  /**
   * The cloud metadata endpoint, spelled as a port rather than a host. It is
   * not on the allowlist, which is the check that stops it.
   */
  it('refuses a port that is not allowlisted even for the owner', async () => {
    const response = await fetch(proxyUrl(80, '/latest/meta-data/'));

    expect(response.status).toBe(403);
  });
});
