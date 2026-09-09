import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  parseClientFrame,
  type ClientFrame,
  type ServerFrame,
} from '../../src/lib/terminal/protocol.ts';
import type { GatewayConfig } from './config.ts';
import { authorizeTerminal, type Authorizer } from './auth.ts';
import { GatewayError, protocolError, resourceLimit, toGatewayError } from './errors.ts';
import { ContainerManager } from './lifecycle.ts';
import { SessionRegistry, TerminalSession } from './session.ts';
import { correlationId, type Logger } from './observability.ts';
import type { ContainerRuntime } from './runtime/types.ts';
import { WORKSPACE_MOUNT } from './runtime/docker.ts';
import { parseProxyPath, proxyHttp, proxyUpgrade } from './ports.ts';
import { SyncService, type SyncSubscriber } from './syncService.ts';

/**
 * The gateway: one HTTP server, three jobs.
 *
 * `/health` for an orchestrator, `/terminal` for the WebSocket protocol, and
 * `/proxy/:container/:port` for development servers. They share a process
 * because they share the container registry and the authorizer, and splitting
 * them into services in V1 would mean inventing a way for them to agree about
 * state that they currently simply have. The boundaries between them are
 * module boundaries, which is what makes splitting them later a deployment
 * change rather than a rewrite.
 *
 * A socket here is anonymous. It becomes a session only after a `hello` frame
 * whose token Supabase verified and whose project the database says the caller
 * may edit. Until then it may send exactly one kind of frame, is subject to a
 * handshake deadline, and is counted against a per-connection frame budget.
 */

export interface GatewayDeps {
  config: GatewayConfig;
  runtime: ContainerRuntime;
  authorizer: Authorizer;
  logger: Logger;
}

/** How long an unauthenticated socket may stay open before it is closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

interface Connection {
  socket: WebSocket;
  correlation: string;
  userId: string | null;
  projectId: string | null;
  session: TerminalSession | null;
  /** Sliding budget, refilled once a second, that bounds frame rate per socket. */
  frameBudget: number;
  budgetResetAt: number;
  /**
   * This socket's subscription to its container's filesystem, if it has one.
   *
   * Held so that closing the socket unsubscribes it. Without that the service
   * keeps a watcher alive for a browser that is gone, and sends change frames
   * into a closed socket forever.
   */
  syncOf: { containerId: string; subscriber: SyncSubscriber } | null;
}

export function createGateway(deps: GatewayDeps): {
  server: Server;
  containers: ContainerManager;
  sessions: SessionRegistry;
  close: () => Promise<void>;
} {
  const { config, runtime, authorizer, logger } = deps;
  const sessions = new SessionRegistry();
  const sync = new SyncService(config, logger);
  const containers = new ContainerManager(config, runtime, sessions, logger, (containerId) =>
    sync.stop(containerId),
  );
  containers.startReaper();

  const server = createServer((request, response) => {
    void handleHttp(request, response);
  });

  /**
   * Every socket the server has accepted.
   *
   * `server.close()` stops listening and then waits for open connections to
   * end, and this service's connections are terminals and proxied dev servers —
   * they do not end. Without this, shutdown hangs, and a gateway that cannot
   * finish shutting down is a gateway that leaves containers running with
   * nothing tracking them. Found by a test whose `afterAll` timed out.
   */
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';

    if (url === '/health' || url.startsWith('/health?')) {
      // Deliberately says nothing about who is using it. A health endpoint is
      // usually the most exposed thing a service has.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          runtime: runtime.name,
          isolated: runtime.isolates,
          protocol: PROTOCOL_VERSION,
          containers: containers.size,
        }),
      );
      return;
    }

    const target = parseProxyPath(url);
    if (target) {
      await proxyHttp(
        {
          config,
          containers,
          authorizer,
          logger,
          runtimeEndpoint: (id, port) => runtime.endpointFor(id, port),
        },
        request,
        response,
        target,
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found.');
  }

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '/';

    const target = parseProxyPath(url);
    if (target) {
      void proxyUpgrade(
        {
          config,
          containers,
          authorizer,
          logger,
          runtimeEndpoint: (id, port) => runtime.endpointFor(id, port),
        },
        request,
        socket as Duplex,
        head,
        target,
      );
      return;
    }

    if (!url.startsWith('/terminal')) {
      socket.destroy();
      return;
    }
    if (!originAllowed(request, config)) {
      logger.event('terminal_rejected', { reason: 'origin not allowed' });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    wss.handleUpgrade(request, socket as Duplex, head, (ws) => acceptTerminal(ws));
  });

  function acceptTerminal(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      correlation: correlationId(),
      userId: null,
      projectId: null,
      session: null,
      frameBudget: LIMITS.maxFramesPerSecond,
      budgetResetAt: Date.now() + 1000,
      syncOf: null,
    };
    logger.event('terminal_connected', { correlationId: connection.correlation });

    const deadline = setTimeout(() => {
      if (!connection.userId) {
        send(connection, {
          type: 'error',
          code: 'AUTH_ERROR',
          message: 'The connection was not authenticated in time.',
          fatal: true,
        });
        socket.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);
    deadline.unref?.();

    socket.on('message', (raw, isBinary) => {
      // Text frames only. A binary frame would be a second parsing path, and
      // one parser is easier to reason about than two.
      if (isBinary) {
        fail(connection, protocolError('binary frame'));
        return;
      }
      void onMessage(connection, String(raw));
    });

    socket.on('close', () => {
      clearTimeout(deadline);
      // Detach, do not kill. A closed tab must leave `npm run dev` running.
      connection.session?.detach();
      if (connection.syncOf) {
        sync.unsubscribe(connection.syncOf.containerId, connection.syncOf.subscriber);
        connection.syncOf = null;
      }
      logger.event('terminal_disconnected', {
        correlationId: connection.correlation,
        userId: connection.userId ?? undefined,
        sessionId: connection.session?.id,
      });
    });

    socket.on('error', () => socket.close());
  }

  async function onMessage(connection: Connection, raw: string): Promise<void> {
    if (!spend(connection)) {
      fail(connection, resourceLimit('You are sending data faster than the terminal accepts.'));
      return;
    }

    let frame: ClientFrame;
    try {
      frame = parseClientFrame(raw);
    } catch (error) {
      logger.event('protocol_violation', {
        correlationId: connection.correlation,
        reason: error instanceof ProtocolError ? error.message : 'unparseable',
      });
      fail(connection, protocolError(error instanceof Error ? error.message : 'unparseable'));
      return;
    }

    try {
      if (frame.type === 'hello') {
        await onHello(connection, frame);
        return;
      }
      if (frame.type === 'ping') {
        send(connection, { type: 'pong', at: frame.at });
        return;
      }

      // Everything past here needs an authenticated socket.
      if (!connection.userId) throw new GatewayError('AUTH_ERROR', 'Not authenticated.');

      // Sync frames are addressed by container rather than by session: a
      // workspace's files outlive any one shell, and two terminals on the same
      // project must not each carry their own view of the tree.
      if (
        frame.type === 'sync-manifest' ||
        frame.type === 'sync-push' ||
        frame.type === 'sync-delete'
      ) {
        await onSync(connection, frame);
        return;
      }

      const session = sessions.find(frame.sessionId, connection.userId);
      if (!session) {
        // Same answer for "no such session" and "not yours": distinguishing
        // them tells a caller which ids exist.
        throw new GatewayError('PERMISSION_ERROR', 'That terminal session is not available.');
      }

      switch (frame.type) {
        case 'input':
          session.write(Buffer.from(frame.data, 'base64').toString('utf8'));
          break;
        case 'resize':
          session.resize(frame.cols, frame.rows);
          break;
        case 'signal':
          session.signal(frame.signal);
          break;
        case 'detach':
          if (frame.kill) sessions.remove(session.id);
          else session.detach();
          connection.session = null;
          break;
      }
      containers.touch(session.containerId);
    } catch (error) {
      fail(connection, toGatewayError(error));
    }
  }

  /**
   * File synchronisation for one container.
   *
   * The container is resolved by `byId` with the caller's own user id, so a
   * client that names somebody else's container gets the same answer as one
   * that names a container that does not exist. That check is the whole
   * authorisation story for sync, and it belongs here rather than in the sync
   * service: the service takes a record it is given, and would have no way to
   * know who asked.
   */
  async function onSync(
    connection: Connection,
    frame: Extract<ClientFrame, { type: 'sync-manifest' | 'sync-push' | 'sync-delete' }>,
  ): Promise<void> {
    const record = containers.byId(frame.containerId, connection.userId!);
    if (!record) {
      throw new GatewayError('PERMISSION_ERROR', 'That workspace is not available.');
    }

    switch (frame.type) {
      case 'sync-manifest': {
        send(connection, await sync.plan(record, frame.files));
        // Subscribed only after a manifest, so a browser starts hearing about
        // the container's changes at the point it knows what it already has.
        // Subscribing at `hello` would deliver changes against a tree the
        // client has not reconciled yet.
        if (!connection.syncOf) {
          const subscriber: SyncSubscriber = (outgoing) => send(connection, outgoing);
          sync.subscribe(record, subscriber);
          connection.syncOf = { containerId: record.id, subscriber };
        }
        break;
      }
      case 'sync-push':
        send(connection, await sync.push(record, frame.files));
        break;
      case 'sync-delete':
        send(connection, await sync.remove(record, frame.paths));
        break;
    }
    containers.touch(record.id);
  }

  async function onHello(connection: Connection, frame: Extract<ClientFrame, { type: 'hello' }>): Promise<void> {
    if (frame.protocol !== PROTOCOL_VERSION) {
      throw new GatewayError(
        'PROTOCOL_ERROR',
        `This terminal speaks protocol ${PROTOCOL_VERSION}; the page is using ${frame.protocol}. Reload TA CODE.`,
      );
    }
    if (connection.userId) throw protocolError('duplicate hello');

    const { identity } = await authorizeTerminal(authorizer, frame.token, frame.projectId);
    connection.userId = identity.userId;
    connection.projectId = frame.projectId;

    const container = await containers.ensure(identity.userId, frame.projectId);

    // Resume, when the client named a session it owns and it is still alive.
    let session = frame.sessionId ? sessions.find(frame.sessionId, identity.userId) : null;
    let resumed = Boolean(session);

    if (session && session.containerId !== container.id) {
      // A session id from another workspace. Refused rather than adopted.
      session = null;
      resumed = false;
    }

    if (!session) {
      if (sessions.countFor(container.id) >= container.tier.maxSessions) {
        throw resourceLimit('This workspace already has the maximum number of terminals open.');
      }
      const cwd = runtime.name === 'docker' ? WORKSPACE_MOUNT : container.workspaceDir;
      const pty = await runtime.spawnShell(container.id, {
        cwd,
        cols: frame.cols ?? 80,
        rows: frame.rows ?? 24,
        env: {
          TERM: 'xterm-color',
          HOME: runtime.name === 'docker' ? '/home/dev' : container.workspaceDir,
          // Nothing about TA CODE's own credentials is in here. A container's
          // environment is readable by everything running in it.
          TA_CODE: '1',
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      });

      session = new TerminalSession({
        id: `sess-${correlationId()}`,
        containerId: container.id,
        userId: identity.userId,
        pty,
      });
      sessions.add(session);
      logger.event('process_started', {
        correlationId: connection.correlation,
        sessionId: session.id,
        containerId: container.id,
        userId: identity.userId,
      });

      session.onExit((exit) => {
        logger.event('process_exited', {
          sessionId: session!.id,
          containerId: container.id,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
        send(connection, {
          type: 'exit',
          sessionId: session!.id,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
      });
    }

    connection.session = session;
    session.attach(
      (chunk) => send(connection, { type: 'output', sessionId: session!.id, ...chunk }),
      () => connection.socket.bufferedAmount,
      frame.lastSeq ?? 0,
    );

    send(connection, {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      sessionId: session.id,
      containerId: container.id,
      status: container.status,
      runtime: runtime.name,
      resumed,
      seq: session.seq,
    });

    logger.event('session_attached', {
      correlationId: connection.correlation,
      sessionId: session.id,
      containerId: container.id,
      userId: identity.userId,
      projectId: frame.projectId,
    });
  }

  /**
   * Frame budget: a socket may send a burst, then is refilled once a second.
   *
   * Bounds a flooding client without penalising a paste, which legitimately
   * arrives as many frames at once.
   */
  function spend(connection: Connection): boolean {
    const now = Date.now();
    if (now > connection.budgetResetAt) {
      connection.frameBudget = LIMITS.maxFramesPerSecond;
      connection.budgetResetAt = now + 1000;
    }
    connection.frameBudget -= 1;
    return connection.frameBudget >= 0;
  }

  function send(connection: Connection, frame: ServerFrame): void {
    if (connection.socket.readyState !== 1) return;
    try {
      connection.socket.send(encodeFrame(frame));
    } catch {
      // A frame we cannot encode is a bug on this side; dropping it is better
      // than tearing down a working terminal.
    }
    if (connection.session && connection.socket.bufferedAmount < 64 * 1024) {
      connection.session.flush();
    }
  }

  function fail(connection: Connection, error: GatewayError): void {
    logger.event(error.code === 'PROTOCOL_ERROR' ? 'protocol_violation' : 'terminal_rejected', {
      correlationId: connection.correlation,
      userId: connection.userId ?? undefined,
      code: error.code,
      reason: error.detail || error.message,
    });
    send(connection, {
      type: 'error',
      code: error.code,
      message: error.message,
      sessionId: connection.session?.id,
      fatal: error.fatal,
    });
    if (error.fatal) connection.socket.close();
  }

  return {
    server,
    containers,
    sessions,
    close: async () => {
      // Watchers first: they hold inotify handles and can still fire during a
      // shutdown, and a change frame delivered while containers are being
      // destroyed is work with nobody left to receive it.
      sync.stopAll();
      // Terminals next, so a client sees a close frame rather than a reset.
      for (const client of wss.clients) client.terminate();
      wss.close();
      // Then containers, which is the part that must not be skipped: their
      // processes outlive this one otherwise.
      await containers.shutdown();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Which pages may open a terminal.
 *
 * A WebSocket is not subject to the same-origin policy, so without this any
 * site a user visits could open a terminal in their workspace using the browser
 * session they already have. Configured explicitly; an empty allowlist means
 * "any origin", which is only reasonable in development and is stated as such
 * in the config documentation.
 */
function originAllowed(request: IncomingMessage, config: GatewayConfig): boolean {
  if (!config.allowedOrigins.length) return true;
  const origin = request.headers.origin;
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}
