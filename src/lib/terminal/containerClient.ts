import {
  LIMITS,
  PROTOCOL_VERSION,
  encodeFrame,
  parseServerFrame,
  type ContainerStatus,
  type ErrorCode,
  type GitOperation,
  type ManifestEntryFrame,
  type ServerFrame,
  type SyncAckFrame,
} from '@/lib/terminal/protocol';

/**
 * The browser end of the container terminal.
 *
 * A thin, testable object with no React and no xterm in it: it owns a socket
 * and turns frames into callbacks. That separation is what lets the reconnect
 * logic — the part with the interesting failure modes — be tested without a
 * DOM or a live gateway.
 *
 * Reconnect is the reason this is not just `new WebSocket`. A terminal that
 * loses its socket has not lost its shell: the session lives on the gateway,
 * so reconnecting means saying which session and how much of its output we
 * already have, and getting the rest replayed. Backoff is bounded and jittered
 * so that a gateway coming back up is not met by every browser at once.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closed'
  | 'unavailable';

export interface ContainerTerminalOptions {
  /** Base URL of the gateway, e.g. `wss://containers.example`. */
  gatewayUrl: string;
  /**
   * The project this terminal serves, or an empty string for a Linux workspace.
   *
   * The two are different features rather than two settings of one. A project
   * terminal is authorised by project membership and syncs the project's files;
   * a Linux workspace belongs to the person, mounts no project, and is reached
   * without a project id at all.
   */
  projectId: string;
  /** Which of the two this client opens. Defaults to `project`. */
  kind?: 'project' | 'linux';
  /** Fetched fresh per attempt: an access token expires, and reconnects retry. */
  token: () => Promise<string | null>;
  cols: number;
  rows: number;
  onOutput: (bytes: Uint8Array) => void;
  onState: (state: ConnectionState, detail?: string) => void;
  onStatus?: (status: ContainerStatus, detail?: string) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  onError?: (code: ErrorCode, message: string, fatal: boolean) => void;
  /** The gateway's answer to a manifest: what to send, and what never will be. */
  onSyncPlan?: (plan: {
    needed: string[];
    diverged: Array<{ path: string; containerHash: string }>;
    skipped: Array<{ path: string; reason: string }>;
    stale: string[];
  }) => void;
  /** The outcome of a push, including any conflict the editor must resolve. */
  onSyncAck?: (results: SyncAckFrame['results']) => void;
  /** What the container did to the files. */
  onSyncChanged?: (
    files: Array<{ path: string; content: string; hash: string }>,
    deleted: string[],
  ) => void;
  /** Too much changed to enumerate; the editor should send a fresh manifest. */
  onSyncStorm?: (count: number) => void;
  /**
   * The answer to a git request.
   *
   * `needsConfirmation` is not a failure: the operation declined to discard
   * uncommitted work, and `atRisk` names what would have been lost so the UI
   * can say what rather than that.
   */
  onGitResult?: (result: {
    requestId: string;
    ok: boolean;
    data?: unknown;
    message?: string;
    needsConfirmation?: boolean;
    atRisk?: string[];
  }) => void;
  /**
   * The answer to a project-check request.
   *
   * `ok` says whether the request could be served, not whether the check
   * passed — a failing test suite arrives with `ok: true` and a non-zero exit
   * code, because that is a result the agent must read rather than an error.
   */
  onCheckResult?: (result: {
    requestId: string;
    ok: boolean;
    available?: string[];
    result?: { script: string; ok: boolean; exitCode: number; output: string; truncated: boolean };
    message?: string;
  }) => void;
  /** The outcome of an explicit transfer between two of the user's workspaces. */
  onTransferResult?: (result: {
    requestId: string;
    copied: string[];
    conflicts: string[];
    skipped: Array<{ path: string; reason: string }>;
  }) => void;
  /**
   * Ports the container is serving, whenever the set changes.
   *
   * A list to offer, not a capability: the proxy authorises every request on
   * its own, so a port appearing here never grants access to it.
   */
  onPorts?: (ports: Array<{ port: number; url: string }>) => void;
  /** Injected in tests; defaults to the platform's WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

const MAX_RECONNECT_DELAY_MS = 15_000;
const BASE_RECONNECT_DELAY_MS = 400;

export class ContainerTerminal {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  /**
   * Set when the gateway refused us for a reason retrying cannot fix.
   *
   * It keeps the socket's own `close` from replacing "you need edit access to
   * this project" with "Disconnected" — the generic state arrives last and
   * would otherwise be the one the user reads, which is the one that does not
   * say what to do.
   */
  private terminal = false;

  /** Set once the gateway has answered; used to resume the same shell. */
  sessionId: string | null = null;
  containerId: string | null = null;
  runtime: string | null = null;
  /** The last output sequence rendered, so a reconnect can ask for the gap. */
  private lastSeq = 0;
  /** Correlates git and transfer answers with the requests that caused them. */
  private nextRequest = 0;
  /** Callers waiting on one transfer each, keyed by the request they sent. */
  private transfers = new Map<
    string,
    (outcome: {
      requestId: string;
      copied: string[];
      conflicts: string[];
      skipped: Array<{ path: string; reason: string }>;
    }) => void
  >();

  constructor(private readonly options: ContainerTerminalOptions) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.options.onState(state, detail);
  }

  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'ready') return;
    // An explicit reconnect clears a previous fatal state: the user asking
    // again is a new decision, and access may have been granted since.
    this.terminal = false;
    this.closedByUs = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const token = await this.options.token();
    if (!token) {
      // Not an error to retry: without a session there is nobody to be.
      this.setState('unavailable', 'Sign in to use the container terminal.');
      return;
    }

    const url = `${this.options.gatewayUrl.replace(/\/+$/, '')}/terminal`;
    let socket: WebSocket;
    try {
      socket = this.options.createSocket ? this.options.createSocket(url) : new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        token,
        projectId: this.options.projectId,
        kind: this.options.kind ?? 'project',
        ...(this.sessionId ? { sessionId: this.sessionId, lastSeq: this.lastSeq } : {}),
        cols: this.options.cols,
        rows: this.options.rows,
      });
    };

    socket.onmessage = (event) => this.onFrame(String(event.data));

    socket.onclose = () => {
      this.socket = null;
      if (this.terminal) return;
      if (this.closedByUs) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows, and it is the one that decides what to do.
    };
  }

  private onFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = parseServerFrame(raw);
    } catch {
      // A frame the gateway should not have sent. Dropped rather than
      // half-applied: these drive an editor.
      return;
    }

    switch (frame.type) {
      case 'ready':
        this.attempt = 0;
        this.sessionId = frame.sessionId;
        this.containerId = frame.containerId;
        this.runtime = frame.runtime;
        if (!frame.resumed) this.lastSeq = 0;
        this.setState('ready');
        this.options.onStatus?.(frame.status);
        break;

      case 'output':
        this.lastSeq = frame.seq;
        this.options.onOutput(base64ToBytes(frame.data));
        break;

      case 'exit':
        // The shell is gone; the next connection starts a new one rather than
        // asking to resume something that has exited.
        this.sessionId = null;
        this.lastSeq = 0;
        this.options.onExit?.(frame.exitCode, frame.signal);
        break;

      case 'status':
        this.options.onStatus?.(frame.status, frame.detail);
        break;

      case 'error':
        this.options.onError?.(frame.code, frame.message, frame.fatal);
        if (frame.fatal) {
          // Retrying an authentication or protocol failure just repeats it.
          this.closedByUs = true;
          this.terminal = true;
          this.setState('unavailable', frame.message);
          this.socket?.close();
        }
        break;

      case 'sync-plan':
        this.options.onSyncPlan?.({
          needed: frame.needed,
          diverged: frame.diverged,
          skipped: frame.skipped,
          stale: frame.stale,
        });
        break;

      case 'sync-ack':
        this.options.onSyncAck?.(frame.results);
        break;

      case 'sync-changed':
        this.options.onSyncChanged?.(frame.files, frame.deleted);
        break;

      case 'sync-storm':
        this.options.onSyncStorm?.(frame.count);
        break;

      case 'git-result':
        this.options.onGitResult?.({
          requestId: frame.requestId,
          ok: frame.ok,
          data: frame.data,
          message: frame.message,
          needsConfirmation: frame.needsConfirmation,
          atRisk: frame.atRisk,
        });
        break;

      case 'check-result':
        this.options.onCheckResult?.({
          requestId: frame.requestId,
          ok: frame.ok,
          available: frame.available,
          result: frame.result,
          message: frame.message,
        });
        break;

      case 'transfer-result': {
        const outcome = {
          requestId: frame.requestId,
          copied: frame.copied,
          conflicts: frame.conflicts,
          skipped: frame.skipped,
        };
        this.options.onTransferResult?.(outcome);
        // A caller that asked for this specific transfer gets it directly, so
        // two transfers in flight cannot be told apart only by guessing.
        const waiting = this.transfers.get(frame.requestId);
        if (waiting) {
          this.transfers.delete(frame.requestId);
          waiting(outcome);
        }
        break;
      }

      case 'ports':
        this.options.onPorts?.(frame.ports.map(({ port, url }) => ({ port, url })));
        break;

      case 'pong':
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    this.attempt += 1;
    // Exponential with jitter: a gateway restarting must not be hit by every
    // browser on the same schedule.
    const backoff = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (this.attempt - 1), MAX_RECONNECT_DELAY_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.setState('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private send(frame: object): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
    } catch {
      // An unencodable frame is a bug here, not a reason to drop the terminal.
    }
  }

  /**
   * Send typed input.
   *
   * Chunked, because a paste is one `onData` call in xterm and can be far
   * larger than a frame is allowed to be.
   */
  write(data: string): void {
    const bytes = new TextEncoder().encode(data);
    for (let offset = 0; offset < bytes.length; offset += LIMITS.maxInputBytes) {
      const slice = bytes.subarray(offset, offset + LIMITS.maxInputBytes);
      this.send({ type: 'input', sessionId: this.sessionId, data: bytesToBase64(slice) });
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.sessionId) return;
    this.send({ type: 'resize', sessionId: this.sessionId, cols, rows });
  }

  interrupt(): void {
    if (!this.sessionId) return;
    this.send({ type: 'signal', sessionId: this.sessionId, signal: 'SIGINT' });
  }

  // -------------------------------------------------------------------------
  // File synchronisation
  //
  // Addressed by container, not by session: the workspace's files belong to the
  // workspace, and two terminals on one project share them. Every method here
  // is a no-op before `ready`, because until then there is no container id to
  // address and a frame naming none is a protocol error.
  // -------------------------------------------------------------------------

  /** Offer the project's file list; the gateway answers with what it needs. */
  sendManifest(files: ManifestEntryFrame[]): void {
    if (!this.containerId) return;
    this.send({ type: 'sync-manifest', containerId: this.containerId, files });
  }

  /**
   * Send edited files into the container.
   *
   * Chunked to the protocol's batch size rather than assumed to fit: a save-all
   * over a large project is one call here and must not become one frame the
   * gateway refuses to read.
   */
  pushFiles(files: Array<{ path: string; content: string; baseHash?: string }>): void {
    if (!this.containerId || !files.length) return;
    for (let offset = 0; offset < files.length; offset += LIMITS.maxSyncBatchFiles) {
      this.send({
        type: 'sync-push',
        containerId: this.containerId,
        files: files.slice(offset, offset + LIMITS.maxSyncBatchFiles),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Real Git
  //
  // A typed operation, never a command line. The gateway builds every git argv
  // itself, so there is no path from anything typed here to a git flag.
  // -------------------------------------------------------------------------

  /** Send a git operation. Resolves with the request id the answer will carry. */
  git(request: GitOperation): string | null {
    if (!this.containerId) return null;
    const requestId = `git-${(this.nextRequest += 1)}`;
    this.send({ type: 'git', requestId, containerId: this.containerId, request });
    return requestId;
  }

  /**
   * Ask which of the project's checks can be run, or run one.
   *
   * A script name, never a command. The gateway holds the allowlist and
   * confirms the project defines the script before running anything.
   */
  check(request: { op: 'list' } | { op: 'run'; script: string }): string | null {
    if (!this.containerId) return null;
    const requestId = `check-${(this.nextRequest += 1)}`;
    this.send({ type: 'check', requestId, containerId: this.containerId, request });
    return requestId;
  }

  /**
   * Copy named files into another workspace this person owns.
   *
   * Both endpoints are authorised by the gateway independently; naming a
   * workspace here is a request, not a claim.
   */
  transfer(
    toContainerId: string,
    paths: string[],
    options: { overwrite?: boolean } = {},
  ): string | null {
    if (!this.containerId || !paths.length) return null;
    const requestId = `xfer-${(this.nextRequest += 1)}`;
    this.send({
      type: 'transfer',
      requestId,
      fromContainerId: this.containerId,
      toContainerId,
      paths: paths.slice(0, LIMITS.maxTransferFiles),
      overwrite: options.overwrite === true,
    });
    return requestId;
  }

  /**
   * Copy files into another workspace and wait for what actually happened.
   *
   * A promise rather than a callback because a transfer is a request with one
   * answer, and the caller needs that answer to report it. A request that
   * outlives the timeout is abandoned — the entry is removed and the caller is
   * told — so a lost frame cannot leave a panel saying "copying…" forever.
   *
   * Rejecting is not the same as copying nothing: the outcome carries conflicts
   * and refusals as data, because those are results the gateway computed.
   */
  transferAndWait(
    toContainerId: string,
    paths: string[],
    options: { overwrite?: boolean; timeoutMs?: number } = {},
  ): Promise<{
    copied: string[];
    conflicts: string[];
    skipped: Array<{ path: string; reason: string }>;
  }> {
    const requestId = this.transfer(toContainerId, paths, options);
    if (!requestId) {
      return Promise.reject(new Error('This workspace is not connected.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.transfers.delete(requestId);
        reject(new Error('The gateway did not answer the transfer.'));
      }, options.timeoutMs ?? 30_000);
      this.transfers.set(requestId, ({ copied, conflicts, skipped }) => {
        clearTimeout(timer);
        // Without the request id: the caller correlated by holding the promise,
        // and passing it on invites somebody to correlate by it a second time.
        resolve({ copied, conflicts, skipped });
      });
    });
  }

  deleteFiles(paths: string[]): void {
    if (!this.containerId || !paths.length) return;
    for (let offset = 0; offset < paths.length; offset += LIMITS.maxSyncBatchFiles) {
      this.send({
        type: 'sync-delete',
        containerId: this.containerId,
        paths: paths.slice(offset, offset + LIMITS.maxSyncBatchFiles),
      });
    }
  }

  /**
   * Stop talking to the gateway.
   *
   * `kill` decides whether the shell dies with the connection. The default is
   * false, which is the point of the feature: closing the panel or the tab
   * leaves `npm run dev` running, and reopening reattaches to it.
   */
  disconnect(kill = false): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sessionId) this.send({ type: 'detach', sessionId: this.sessionId, kill });
    if (kill) {
      this.sessionId = null;
      this.lastSeq = 0;
    }
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }
}

/**
 * Base64 without `Buffer`.
 *
 * Terminal traffic is bytes — escape sequences and whatever a process prints —
 * and is not valid UTF-8 in general, so it cannot travel as a JSON string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Where the gateway is, if there is one.
 *
 * Public by design — it is a URL, not a credential — and absent by default, so
 * a deployment with no container infrastructure simply has no container
 * terminal and keeps the virtual one. That is the fallback the whole feature is
 * expected to degrade to.
 */
export function gatewayUrl(): string | null {
  const configured = import.meta.env.VITE_CONTAINER_GATEWAY_URL;
  if (typeof configured !== 'string' || !configured.trim()) return null;
  const url = configured.trim();
  return /^wss?:\/\//.test(url) ? url : null;
}

export function containerTerminalAvailable(): boolean {
  return gatewayUrl() !== null;
}
