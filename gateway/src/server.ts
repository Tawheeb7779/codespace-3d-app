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
import { atLeast, authorizeTerminal, type Authorizer } from './auth.ts';
import { GatewayError, protocolError, resourceLimit, toGatewayError } from './errors.ts';
import { ContainerManager } from './lifecycle.ts';
import { SessionRegistry, TerminalSession } from './session.ts';
import { correlationId, type Logger } from './observability.ts';
import type { ContainerRuntime } from './runtime/types.ts';
import { WORKSPACE_MOUNT } from './runtime/docker.ts';
import { parseProxyPath, proxyHttp, proxyUpgrade } from './ports.ts';
import { SyncService, type SyncSubscriber } from './syncService.ts';
import { PortWatcher, proxyPathFor } from './portDiscovery.ts';
import * as gitOps from './git.ts';
import { transferFiles } from './transfer.ts';

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
  /** The authenticated address, used as the git author and nothing else. */
  email: string;
  /** Which workspace concept this socket opened. Decides how it is revalidated. */
  kind: 'project' | 'linux';
  session: TerminalSession | null;
  /** Sliding budget, refilled once a second, that bounds frame rate per socket. */
  frameBudget: number;
  budgetResetAt: number;
  /**
   * File bytes this socket may still push this second.
   *
   * Separate from the frame budget because they bound different things: the
   * frame budget says how often a client may speak, this says how much work
   * each frame may ask for. A push is a disk write, and a client staying inside
   * the frame budget can still ask for gigabytes a second of them.
   */
  syncBudget: number;
  syncResetAt: number;
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

  /**
   * Port discovery, and where its results go.
   *
   * The frame is addressed to every socket authenticated as the container's
   * owner, because a preview belongs to the workspace rather than to the
   * terminal tab that happened to start the server. Ownership is the filter,
   * so a port is never announced to a connection that could not use it.
   */
  const ports = new PortWatcher({
    config,
    runtime,
    logger,
    onPorts: (record, open) => {
      for (const connection of connections) {
        if (connection.userId !== record.userId) continue;
        send(connection, {
          type: 'ports',
          containerId: record.id,
          ports: open.map((port) => ({ port, url: proxyPathFor(record.id, port), protocol: 'http' as const })),
        });
      }
    },
  });
  ports.start(() => containers.list());

  /**
   * Re-check that everyone with an open terminal may still have one.
   *
   * Authorisation happens at `hello`, and a terminal then lives for hours. A
   * user demoted from editor to viewer, removed from the project, or whose
   * project was deleted keeps a running shell against files they can no longer
   * open in the editor — the check that let them in has no expiry.
   *
   * On a timer rather than per frame: the role lives in Postgres, and a lookup
   * per keystroke would put a database round trip in the path of typing. One
   * interval is the bound on how long revoked access survives, and it is
   * configurable for an operator who wants it tighter.
   *
   * The identity is not re-verified here, only the role. Re-verifying identity
   * needs the caller's token, and the gateway deliberately does not keep one —
   * a stored access token is a credential at rest for no gain, since a
   * reconnect presents a fresh one. Token expiry is instead bounded by the
   * container's own idle and lifetime limits.
   */
  const revalidator = setInterval(() => {
    void revalidate().catch(() => undefined);
  }, Math.max(5, config.roleRecheckSeconds) * 1000);
  revalidator.unref?.();

  async function revalidate(): Promise<void> {
    for (const connection of [...connections]) {
      const { userId, projectId } = connection;
      // A Linux workspace has no project membership to lose. It belongs to the
      // person, and the person is still the person; revalidating it against a
      // project role would close it for a reason that does not apply.
      if (connection.kind === 'linux') continue;
      if (!userId || !projectId) continue;

      // A lookup that fails is not a revocation. Supabase being briefly
      // unreachable must not close every terminal on the host.
      const role = await authorizer.roleOn(userId, projectId).catch(() => undefined);
      if (role === undefined) continue;
      if (atLeast(role, 'editor')) continue;

      logger.event('terminal_rejected', {
        correlationId: connection.correlation,
        userId,
        projectId,
        reason: 'project access was revoked while a terminal was open',
      });

      // The session goes, not just the socket: leaving the shell running would
      // let the same user reattach to it on the next connection.
      if (connection.session) sessions.remove(connection.session.id);
      connection.session = null;
      if (connection.syncOf) {
        sync.unsubscribe(connection.syncOf.containerId, connection.syncOf.subscriber);
        connection.syncOf = null;
      }
      fail(
        connection,
        new GatewayError(
          'PERMISSION_ERROR',
          'Your access to this project changed, so this terminal was closed.',
        ),
      );
      connection.socket.close();
    }
  }

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
  /** Authenticated connections, for frames nobody asked for — ports, mainly. */
  const connections = new Set<Connection>();

  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

  /**
   * Whether the container runtime is answering, cached briefly.
   *
   * Cached because a health endpoint is polled every few seconds by every
   * probe that exists, and `docker version` is a round trip to a daemon that
   * may be the thing under strain. Briefly, because the point of asking is to
   * notice when the answer changes.
   */
  let runtimeCheckedAt = 0;
  let runtimeOk = true;
  async function runtimeHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - runtimeCheckedAt < 5000) return runtimeOk;
    runtimeCheckedAt = now;
    runtimeOk = await runtime.available().catch(() => false);
    return runtimeOk;
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';

    if (url === '/health' || url.startsWith('/health?')) {
      // Two different questions, and conflating them is how an orchestrator
      // keeps routing traffic to a gateway that cannot start a single
      // workspace. `ok` is "this process is serving"; `runtimeAvailable` is
      // "the container runtime answers". A 503 when the runtime is gone is
      // what makes a load balancer act on the difference.
      const runtimeAvailable = await runtimeHealth();
      response.writeHead(runtimeAvailable ? 200 : 503, { 'content-type': 'application/json' });
      // Deliberately says nothing about who is using it. A health endpoint is
      // usually the most exposed thing a service has.
      response.end(
        JSON.stringify({
          ok: true,
          runtimeAvailable,
          runtime: runtime.name,
          isolated: runtime.isolates,
          protocol: PROTOCOL_VERSION,
          containers: containers.size,
          connections: connections.size,
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
    // Refused before the WebSocket is accepted, so a flood costs a rejected
    // handshake rather than a socket held for the handshake deadline.
    if (connections.size >= config.maxConnections) {
      logger.event('terminal_rejected', { reason: 'gateway at connection capacity' });
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
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
      email: '',
      kind: 'project',
      session: null,
      frameBudget: LIMITS.maxFramesPerSecond,
      budgetResetAt: Date.now() + 1000,
      syncBudget: config.maxSyncBytesPerSecond,
      syncResetAt: Date.now() + 1000,
      syncOf: null,
    };
    connections.add(connection);
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
      connections.delete(connection);
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
      if (frame.type === 'git') {
        await onGit(connection, frame);
        return;
      }
      if (frame.type === 'transfer') {
        await onTransfer(connection, frame);
        return;
      }
      if (
        frame.type === 'sync-manifest' ||
        frame.type === 'sync-push' ||
        frame.type === 'sync-delete'
      ) {
        if (frame.type === 'sync-push' && !spendSync(connection, frame.files)) {
          fail(connection, resourceLimit('Files are being synchronised faster than the workspace accepts.'));
          return;
        }
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

  /**
   * Real git, against the workspace the caller owns.
   *
   * The container is resolved by id *and* owner, exactly as sync is, so a git
   * request naming somebody else's workspace is refused before any command is
   * built. Nothing from the frame reaches a command line: `git.ts` builds every
   * argv from the typed operation.
   *
   * A destructive refusal is answered as `needsConfirmation` rather than as a
   * failure, because it is not one — the operation declined to discard work,
   * and the client's job is to say what would be lost and ask.
   */
  async function onGit(
    connection: Connection,
    frame: Extract<ClientFrame, { type: 'git' }>,
  ): Promise<void> {
    const record = containers.byId(frame.containerId, connection.userId!);
    if (!record) throw new GatewayError('PERMISSION_ERROR', 'That workspace is not available.');

    const runner = { runtime, record };
    const answer = (
      body: Partial<Extract<ServerFrame, { type: 'git-result' }>>,
    ): void =>
      send(connection, {
        type: 'git-result',
        requestId: frame.requestId,
        containerId: record.id,
        ok: false,
        ...body,
      } as ServerFrame);

    try {
      const request = frame.request;
      let data: unknown;

      switch (request.op) {
        case 'status':
          data = await gitOps.status(runner);
          break;
        case 'log':
          data = await gitOps.log(runner, request.limit ?? 50);
          break;
        case 'diff':
          data = await gitOps.diff(runner, { staged: request.staged, path: request.path });
          break;
        case 'branches':
          data = await gitOps.branches(runner);
          break;
        case 'show':
          data = await gitOps.show(runner, request.ref);
          break;
        case 'rev-parse':
          data = await gitOps.revParse(runner, request.ref);
          break;
        case 'remotes':
          data = await gitOps.remotes(runner);
          break;
        case 'init':
          data = await gitOps.init(runner);
          break;
        case 'add':
          await gitOps.add(runner, request.paths);
          data = await gitOps.status(runner);
          break;
        case 'unstage':
          await gitOps.unstage(runner, request.paths);
          data = await gitOps.status(runner);
          break;
        case 'commit':
          // The author is the authenticated identity, never anything the client
          // sent: a commit attributed to somebody else is a forged record.
          data = await gitOps.commit(runner, request.message, {
            name: connection.email || 'TA CODE user',
            email: connection.email || 'user@ta.code',
          });
          break;
        case 'create-branch':
          await gitOps.createBranch(runner, request.name);
          data = await gitOps.branches(runner);
          break;
        case 'checkout':
          await gitOps.checkout(runner, request.ref, { confirm: request.confirm });
          data = await gitOps.status(runner);
          break;
        case 'discard':
          await gitOps.discard(runner, request.paths, { confirm: request.confirm });
          data = await gitOps.status(runner);
          break;
        case 'delete-branch':
          await gitOps.deleteBranch(runner, request.name, { confirm: request.confirm });
          data = await gitOps.branches(runner);
          break;
      }

      containers.touch(record.id);
      answer({ ok: true, data });
    } catch (error) {
      const failure = toGatewayError(error);
      const refusal = failure.detail === 'refused: unconfirmed destructive operation';
      const plan = refusal ? await gitOps.destructivePlan({ runtime, record }).catch(() => null) : null;
      logger.event('git_refused', {
        containerId: record.id,
        userId: record.userId,
        reason: refusal ? 'destructive operation not confirmed' : failure.code,
      });
      answer({
        ok: false,
        message: failure.message,
        needsConfirmation: refusal,
        atRisk: plan?.paths,
      });
    }
  }

  /**
   * An explicit copy between two workspaces the same person owns.
   *
   * Both endpoints are resolved by id and by owner, independently. That is what
   * makes this a transfer rather than a way to read somebody else's workspace by
   * naming it as a source.
   */
  async function onTransfer(
    connection: Connection,
    frame: Extract<ClientFrame, { type: 'transfer' }>,
  ): Promise<void> {
    const from = containers.byId(frame.fromContainerId, connection.userId!);
    const to = containers.byId(frame.toContainerId, connection.userId!);
    if (!from || !to) {
      throw new GatewayError('PERMISSION_ERROR', 'That workspace is not available.');
    }

    const outcome = await transferFiles(from, to, frame.paths, { overwrite: frame.overwrite });

    // Counts, never paths: a file's name is the user's content.
    logger.event('transfer_completed', {
      userId: connection.userId ?? undefined,
      containerId: to.id,
      files: outcome.copied.length,
    });

    containers.touch(from.id);
    containers.touch(to.id);
    send(connection, { type: 'transfer-result', requestId: frame.requestId, ...outcome });
  }

  async function onHello(connection: Connection, frame: Extract<ClientFrame, { type: 'hello' }>): Promise<void> {
    if (frame.protocol !== PROTOCOL_VERSION) {
      throw new GatewayError(
        'PROTOCOL_ERROR',
        `This terminal speaks protocol ${PROTOCOL_VERSION}; the page is using ${frame.protocol}. Reload TA CODE.`,
      );
    }
    if (connection.userId) throw protocolError('duplicate hello');

    /**
     * Two workspace concepts, two authorisation paths.
     *
     * A project workspace needs edit access to that project — a viewer may read
     * a project in the editor and must not get a shell in it. A Linux workspace
     * has no project: it belongs to the person, so identity is the whole check,
     * and membership of any project grants nothing here.
     *
     * `identify` is the same verified-token path in both cases. What differs is
     * only whether a project role is additionally required.
     */
    const kind = frame.kind === 'linux' ? 'linux' : 'project';
    let identity;
    if (kind === 'linux') {
      if (frame.projectId) {
        throw protocolError('a Linux workspace does not belong to a project');
      }
      identity = await authorizer.identify(frame.token);
    } else {
      if (!frame.projectId) throw protocolError('a project terminal needs a project');
      ({ identity } = await authorizeTerminal(authorizer, frame.token, frame.projectId));
    }

    // Counted after authentication, because before it there is no user to
    // count against — which is also why the total cap above exists separately.
    let mine = 0;
    for (const other of connections) if (other.userId === identity.userId) mine += 1;
    if (mine >= config.maxConnectionsPerUser) {
      throw resourceLimit('You have too many terminals open. Close one and try again.');
    }

    connection.userId = identity.userId;
    connection.projectId = kind === 'linux' ? null : frame.projectId;
    connection.email = identity.email;
    connection.kind = kind;

    const container = await containers.ensure(
      identity.userId,
      kind === 'linux' ? null : frame.projectId,
      config.defaultTier,
      kind,
    );

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
        /**
         * At the cap, but perhaps not actually in use.
         *
         * Closing a tab detaches a session rather than killing it, because
         * `npm run dev` has to survive a closed laptop. The consequence, found
         * by opening and closing terminals under concurrency: a user who opens
         * three and closes them holds all three slots until the idle reaper
         * runs a quarter of an hour later, and every attempt in between is
         * refused. They are locked out of their own workspace by their own
         * finished terminals.
         *
         * A detached session is exactly what a reopened panel wants, so the
         * oldest one is adopted instead of refused. Nothing is killed, the cap
         * still bounds how many terminals can be *attached* at once, and the
         * client is told `resumed` so it knows the scrollback is not new.
         *
         * Same user, same container — ownership is already established above,
         * so adopting one cannot reach anybody else's shell.
         */
        const reusable = sessions
          .forContainer(container.id)
          .filter((candidate) => !candidate.attached && candidate.state === 'running')
          .sort((a, b) => a.lastActivity - b.lastActivity)[0];

        if (reusable) {
          session = reusable;
          resumed = true;
          logger.event('session_attached', {
            correlationId: connection.correlation,
            sessionId: session.id,
            containerId: container.id,
            userId: identity.userId,
            reason: 'adopted a detached session at the terminal cap',
          });
        } else {
          throw resourceLimit('This workspace already has the maximum number of terminals open.');
        }
      }
    }

    if (!session) {
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

  /**
   * Charge a push against this socket's byte budget, refilled once a second.
   *
   * Refused as a whole rather than partially: applying half a batch would
   * leave the editor believing files landed that did not, and the conflict
   * machinery cannot tell that apart from a container-side change.
   */
  function spendSync(connection: Connection, files: Array<{ content: string }>): boolean {
    const now = Date.now();
    if (now > connection.syncResetAt) {
      connection.syncBudget = config.maxSyncBytesPerSecond;
      connection.syncResetAt = now + 1000;
    }
    let bytes = 0;
    for (const file of files) bytes += file.content.length;
    if (bytes > connection.syncBudget) return false;
    connection.syncBudget -= bytes;
    return true;
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
      clearInterval(revalidator);
      ports.stop();
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
