import { connect as netConnect, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GatewayConfig } from './config.ts';
import type { ContainerManager } from './lifecycle.ts';
import type { Authorizer } from './auth.ts';
import { authorizeTerminal } from './auth.ts';
import type { Logger } from './observability.ts';

/**
 * Reaching a development server inside a container, without opening it to the
 * world.
 *
 * The container publishes nothing. Its ports are reachable only from this
 * process, and this process will connect to one only for a caller who has
 * proved, per request, that they may use that container. That is the whole
 * design: a preview URL is not a capability, it is a request that gets
 * authorised like any other.
 *
 * Raw sockets rather than an HTTP client, because a development server is not
 * an HTTP server. Vite, Next and webpack all upgrade to WebSockets for hot
 * reload, and many stream server-sent events. Proxying at the TCP level after
 * the request line has been rewritten carries all of that — upgrades, chunked
 * bodies, SSE, trailers — without the proxy needing to understand any of it.
 *
 * Two things are deliberately *not* done. The proxy does not rewrite response
 * bodies: a URL rewriter that guesses at HTML and JavaScript breaks source maps
 * and inline scripts, and gets it wrong on the one page that matters. And it
 * does not forward cookies to a different origin than they were set for; the
 * proxy path is origin-isolated per container, which is what keeps one
 * workspace's dev server from reading another's storage.
 */

const PROXY_PATH = /^\/proxy\/([A-Za-z0-9_-]{1,128})\/(\d{1,5})(\/.*)?$/;

export interface ProxyTarget {
  containerId: string;
  port: number;
  rest: string;
}

export function parseProxyPath(url: string): ProxyTarget | null {
  const path = url.split('?')[0] ?? '';
  const match = PROXY_PATH.exec(path);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { containerId: match[1], port, rest: match[3] || '/' };
}

/** The token for a proxy request, from the header or the query. */
function tokenFrom(request: IncomingMessage): string {
  const header = request.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // A browser cannot set a header on an `<iframe>` load or a WebSocket
  // handshake, so a query parameter is the only way a preview can authenticate
  // at all. It is the user's own short-lived session token, over TLS, to an
  // endpoint that does not log query strings.
  const url = new URL(request.url ?? '/', 'http://gateway.invalid');
  return url.searchParams.get('access_token') ?? '';
}

export interface PortProxyDeps {
  config: GatewayConfig;
  containers: ContainerManager;
  authorizer: Authorizer;
  logger: Logger;
  runtimeEndpoint: (containerId: string, port: number) => Promise<{ host: string; port: number } | null>;
}

async function authorize(
  deps: PortProxyDeps,
  request: IncomingMessage,
  target: ProxyTarget,
): Promise<{ host: string; port: number }> {
  if (!deps.config.allowedPorts.includes(target.port)) {
    deps.logger.event('port_denied', { containerId: target.containerId, port: target.port, reason: 'not allowlisted' });
    throw new Error('port not allowed');
  }

  const identity = await deps.authorizer.identify(tokenFrom(request));
  const record = deps.containers.byId(target.containerId, identity.userId);
  if (!record) {
    deps.logger.event('port_denied', {
      containerId: target.containerId,
      userId: identity.userId,
      reason: 'not this user’s container',
    });
    throw new Error('no such container');
  }
  // Membership is re-checked per request rather than trusted from when the
  // container was created: access can be revoked while a preview stays open.
  await authorizeTerminal(deps.authorizer, tokenFrom(request), record.projectId);

  const endpoint = await deps.runtimeEndpoint(target.containerId, target.port);
  if (!endpoint) throw new Error('container is not reachable');
  deps.containers.touch(target.containerId);
  return endpoint;
}

/** Serve an HTTP request by relaying it to the container. */
export async function proxyHttp(
  deps: PortProxyDeps,
  request: IncomingMessage,
  response: ServerResponse,
  target: ProxyTarget,
): Promise<void> {
  let endpoint: { host: string; port: number };
  try {
    endpoint = await authorize(deps, request, target);
  } catch {
    // One message for every refusal. Telling a caller which check failed says
    // whether a container exists, which is itself worth not saying.
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('Not available.');
    return;
  }

  const upstream = netConnect(endpoint.port, endpoint.host);
  const cleanup = () => {
    upstream.destroy();
  };

  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('The development server is not responding on that port.');
    } else {
      response.end();
    }
  });

  upstream.on('connect', () => {
    const headers = rewriteRequestHeaders(request, endpoint);
    upstream.write(`${request.method} ${target.rest}${queryOf(request.url ?? '')} HTTP/1.1\r\n`);
    for (const [name, value] of headers) upstream.write(`${name}: ${value}\r\n`);
    upstream.write('\r\n');
    request.pipe(upstream);
    // The response is relayed verbatim, so chunked bodies and SSE work with no
    // understanding of either.
    upstream.pipe(response.socket ?? response);
  });

  response.on('close', cleanup);
  request.on('error', cleanup);
  deps.logger.event('port_opened', { containerId: target.containerId, port: target.port });
}

/**
 * Relay a WebSocket upgrade, which is what hot module reloading rides on.
 *
 * After the handshake there is nothing HTTP-shaped left, so both directions are
 * piped as bytes.
 */
export async function proxyUpgrade(
  deps: PortProxyDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
): Promise<void> {
  let endpoint: { host: string; port: number };
  try {
    endpoint = await authorize(deps, request, target);
  } catch {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  const upstream: Socket = netConnect(endpoint.port, endpoint.host);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());

  upstream.on('connect', () => {
    upstream.write(`${request.method} ${target.rest}${queryOf(request.url ?? '')} HTTP/1.1\r\n`);
    for (const [name, value] of rewriteRequestHeaders(request, endpoint)) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write('\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const close = () => {
    upstream.destroy();
    socket.destroy();
    deps.logger.event('port_closed', { containerId: target.containerId, port: target.port });
  };
  socket.on('close', close);
  upstream.on('close', close);
}

function queryOf(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return '';
  // The access token is the proxy's business, not the dev server's.
  const params = new URLSearchParams(url.slice(index + 1));
  params.delete('access_token');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * The headers that cross, and the ones that do not.
 *
 * Hop-by-hop headers are dropped because forwarding them corrupts the
 * connection. `authorization` is dropped because it carries the user's TA CODE
 * session, and handing that to whatever a user is running in their container
 * would turn a dev server into a credential harvester.
 */
const DROPPED = new Set([
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function rewriteRequestHeaders(
  request: IncomingMessage,
  endpoint: { host: string; port: number },
): Array<[string, string]> {
  const out: Array<[string, string]> = [['host', `${endpoint.host}:${endpoint.port}`]];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (DROPPED.has(lower)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) out.push([lower, entry]);
  }
  // Upgrades still need their own headers, restored after the blanket drop.
  const upgrade = request.headers.upgrade;
  if (upgrade) {
    out.push(['connection', 'Upgrade']);
    out.push(['upgrade', String(upgrade)]);
  } else {
    out.push(['connection', 'close']);
  }
  return out;
}
