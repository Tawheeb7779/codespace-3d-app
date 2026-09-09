/**
 * The wire protocol between TA CODE and the container gateway.
 *
 * One definition, imported by both sides — the browser client from `src/`, the
 * gateway from its own package — because a protocol described twice is a
 * protocol that drifts. It is pure data and pure functions: no DOM, no Node, no
 * imports, so it typechecks in both builds.
 *
 * Everything here assumes the peer is hostile. The browser is not trusted by
 * the gateway (a WebSocket is an anonymous socket until proven otherwise), and
 * the gateway's frames are not trusted by the browser (a compromised or
 * confused gateway must not be able to make the editor write arbitrary paths).
 * So every frame is validated on arrival, on both ends, by the same code.
 */

/**
 * Bumped when a change would make an old client misread a new frame.
 *
 * The client sends it in `hello`; a gateway that does not recognise it refuses
 * the connection with a message naming both versions, rather than accepting a
 * frame it will misinterpret.
 */
export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Limits
//
// These are protocol limits, not policy: they bound what a single frame can do
// to the peer's memory before anything has decided whether the sender is even
// allowed to be here. Resource policy — how much CPU a container gets, how many
// sessions a user may open — lives in the gateway's config.
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Largest frame accepted, before parsing. A megabyte of JSON is not a keystroke. */
  maxFrameBytes: 256 * 1024,
  /** Largest single chunk of terminal input. Paste is chunked above this. */
  maxInputBytes: 64 * 1024,
  /** Largest output chunk the gateway will emit in one frame. */
  maxOutputBytes: 64 * 1024,
  /** Terminal geometry, wide enough for any real screen and bounded. */
  maxCols: 500,
  maxRows: 300,
  /** Identifier length, so an id cannot be used as a payload. */
  maxIdLength: 128,
  /** Frames per second from one client before it is throttled. */
  maxFramesPerSecond: 200,
  /** Output bytes buffered per session for replay after a reconnect. */
  replayBufferBytes: 256 * 1024,
  /**
   * Largest file either side will synchronise.
   *
   * Well under `maxFrameBytes`, because a sync frame carries a file *and* its
   * envelope, and because a file this size is not one somebody is editing — it
   * is a bundle, a lockfile or an asset, and copying it on every keystroke is
   * how a sync engine becomes the reason the editor is slow.
   */
  maxSyncFileBytes: 128 * 1024,
  /** Files in one push or one change batch, so a batch stays a frame. */
  maxSyncBatchFiles: 64,
  /** Paths in a manifest. A project larger than this does not get a container. */
  maxManifestFiles: 5000,
  /** Path length on the wire, before either side normalises it. */
  maxPathLength: 1024,
} as const;

// ---------------------------------------------------------------------------
// Error categories
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'AUTH_ERROR'
  | 'PERMISSION_ERROR'
  | 'CONTAINER_ERROR'
  | 'PTY_ERROR'
  | 'SYNC_ERROR'
  | 'PORT_ERROR'
  | 'RESOURCE_LIMIT'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL_ERROR';

/** Categories after which the client must not simply retry the same frame. */
export const FATAL_ERRORS: readonly ErrorCode[] = [
  'AUTH_ERROR',
  'PERMISSION_ERROR',
  'PROTOCOL_ERROR',
];

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

export type ContainerStatus =
  | 'creating'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'expired';

/** States in which a terminal can be attached. */
export const ATTACHABLE: readonly ContainerStatus[] = ['ready'];

// ---------------------------------------------------------------------------
// Client -> gateway
// ---------------------------------------------------------------------------

export interface HelloFrame {
  type: 'hello';
  protocol: number;
  /**
   * The caller's Supabase access token.
   *
   * In the frame rather than a header because a browser cannot set headers on a
   * WebSocket handshake, and a token in the URL would reach access logs and
   * `Referer`. The gateway verifies it with Supabase; it is never decoded
   * client-side to decide anything.
   */
  token: string;
  projectId: string;
  /** Resume an existing session instead of starting a shell. */
  sessionId?: string;
  /** Last sequence the client saw, so the gateway can replay the gap. */
  lastSeq?: number;
  cols?: number;
  rows?: number;
}

export interface InputFrame {
  type: 'input';
  sessionId: string;
  /** Raw bytes for the PTY, base64 — terminal input is not valid UTF-8 text. */
  data: string;
}

export interface ResizeFrame {
  type: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface SignalFrame {
  type: 'signal';
  sessionId: string;
  /** Only signals a terminal user can already send from a keyboard. */
  signal: 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGHUP';
}

export interface DetachFrame {
  type: 'detach';
  sessionId: string;
  /**
   * Whether the shell should die with the connection.
   *
   * Default false, and that default is the point: closing a laptop lid must not
   * kill `npm run dev`. A session outlives its socket until the container's own
   * idle policy reclaims it.
   */
  kill?: boolean;
}

export interface PingFrame {
  type: 'ping';
  at: number;
}

// ---------------------------------------------------------------------------
// File synchronisation
//
// The editor's virtual filesystem and the container's real one are two writers
// over one tree. These frames are the whole conversation between them, and its
// shape follows from one decision: content hashes, never timestamps.
//
// A hash answers "is this the same file", which is a question both sides can
// answer identically. A timestamp answers "which happened later", which is the
// wrong question — `npm install` rewrites thousands of mtimes, the container's
// clock is not the browser's, and a file written twice with the same bytes is
// not a change at all.
// ---------------------------------------------------------------------------

/** One file's identity, without its content. */
export interface ManifestEntryFrame {
  path: string;
  hash: string;
  size: number;
}

/**
 * "Here is my whole project; tell me what you are missing."
 *
 * Sent once when the panel opens, and again after a storm. The answer is a
 * list of paths, not a transfer, so a reconnect costs the files that actually
 * differ rather than the project — on a large repository that is the
 * difference between a feature and one nobody waits for.
 */
export interface SyncManifestFrame {
  type: 'sync-manifest';
  containerId: string;
  files: ManifestEntryFrame[];
}

export interface SyncPushFrame {
  type: 'sync-push';
  containerId: string;
  files: Array<{
    path: string;
    content: string;
    /**
     * What the editor believed the file held before this edit.
     *
     * The conflict check, and the reason this is not just a write. If the file
     * on disk is neither this nor what is being written, the container changed
     * it too and the gateway refuses rather than choosing a winner.
     */
    baseHash?: string;
  }>;
}

export interface SyncDeleteFrame {
  type: 'sync-delete';
  containerId: string;
  paths: string[];
}

export type ClientFrame =
  | HelloFrame
  | InputFrame
  | ResizeFrame
  | SignalFrame
  | DetachFrame
  | PingFrame
  | SyncManifestFrame
  | SyncPushFrame
  | SyncDeleteFrame;

// ---------------------------------------------------------------------------
// Gateway -> client
// ---------------------------------------------------------------------------

export interface ReadyFrame {
  type: 'ready';
  protocol: number;
  sessionId: string;
  containerId: string;
  status: ContainerStatus;
  /** Which runtime is behind this session, so the UI can say so honestly. */
  runtime: string;
  /** True when the shell was resumed rather than started. */
  resumed: boolean;
  /** Sequence of the last output frame the gateway has, for gap detection. */
  seq: number;
}

export interface OutputFrame {
  type: 'output';
  sessionId: string;
  /** Monotonic per session. The client uses it to spot a gap after a reconnect. */
  seq: number;
  /** Raw PTY bytes, base64. */
  data: string;
}

export interface ExitFrame {
  type: 'exit';
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface StatusFrame {
  type: 'status';
  containerId: string;
  status: ContainerStatus;
  detail?: string;
}

export interface PortsFrame {
  type: 'ports';
  containerId: string;
  ports: Array<{ port: number; url: string; protocol: 'http' }>;
}

export interface ErrorFrame {
  type: 'error';
  code: ErrorCode;
  /** Safe for a user to read. Never a stack trace, a path, or a credential. */
  message: string;
  sessionId?: string;
  fatal: boolean;
}

export interface PongFrame {
  type: 'pong';
  at: number;
}

/** The answer to a manifest: what to send, what will never be sent, what is extra. */
export interface SyncPlanFrame {
  type: 'sync-plan';
  containerId: string;
  /** Paths the container does not have at all, so sending them is safe. */
  needed: string[];
  /**
   * Paths both sides hold with different content.
   *
   * Not "needed": pushing over one of these loses whichever version the person
   * did not choose, and they have not been asked. Reported with the
   * container's hash so the editor can present the disagreement.
   */
  diverged: Array<{ path: string; containerHash: string }>;
  /** Paths that will never cross, each with a reason a user can read. */
  skipped: Array<{ path: string; reason: string }>;
  /**
   * In the container, unknown to the editor.
   *
   * Reported, never deleted: a container's extra files are usually build
   * output, and deleting whatever the editor has not heard of is how a sync
   * engine destroys the `dist` somebody was serving.
   */
  stale: string[];
}

export interface SyncAckFrame {
  type: 'sync-ack';
  containerId: string;
  results: Array<
    | { status: 'written' | 'unchanged'; path: string; hash: string }
    | { status: 'skipped'; path: string; reason: string }
    | { status: 'conflict'; path: string; containerHash: string; editorHash: string }
  >;
}

/** What the container did to the files, pushed as it happens. */
export interface SyncChangedFrame {
  type: 'sync-changed';
  containerId: string;
  files: Array<{ path: string; content: string; hash: string }>;
  deleted: string[];
}

/**
 * "Too much changed to list."
 *
 * `npm install` writes tens of thousands of files. Enumerating them is not a
 * smaller problem than resynchronising, so past a threshold the gateway says
 * how many and the editor sends a fresh manifest. Degrading loudly beats
 * falling over quietly.
 */
export interface SyncStormFrame {
  type: 'sync-storm';
  containerId: string;
  count: number;
}

export type ServerFrame =
  | ReadyFrame
  | OutputFrame
  | ExitFrame
  | StatusFrame
  | PortsFrame
  | ErrorFrame
  | PongFrame
  | SyncPlanFrame
  | SyncAckFrame
  | SyncChangedFrame
  | SyncStormFrame;

// ---------------------------------------------------------------------------
// Validation
//
// Hand-written rather than schema-driven, because this runs on every frame of a
// terminal stream and because the failure mode of a validator that is itself
// slow or allocation-heavy is the flooding it exists to prevent.
// ---------------------------------------------------------------------------

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(frame: Record<string, unknown>, field: string, max: number): string {
  const value = frame[field];
  if (typeof value !== 'string') throw new ProtocolError(`${field} must be a string`);
  if (value.length > max) throw new ProtocolError(`${field} is too long`);
  return value;
}

function optionalStr(frame: Record<string, unknown>, field: string, max: number): string | undefined {
  return frame[field] === undefined ? undefined : str(frame, field, max);
}

function int(frame: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = frame[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${field} must be a number`);
  }
  const rounded = Math.floor(value);
  if (rounded < min || rounded > max) throw new ProtocolError(`${field} is out of range`);
  return rounded;
}

/**
 * An identifier the gateway will use to look something up.
 *
 * Restricted to a character set that cannot be a path, a shell fragment, or a
 * PostgREST filter, because an id from a client is eventually interpolated into
 * one of those by somebody, somewhere.
 */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function id(frame: Record<string, unknown>, field: string): string {
  const value = str(frame, field, LIMITS.maxIdLength);
  if (!ID.test(value)) throw new ProtocolError(`${field} is not a valid identifier`);
  return value;
}

/**
 * A workspace-relative path, checked syntactically.
 *
 * This is not the security boundary and must not be mistaken for one: the
 * boundary is `resolveInWorkspace` in the gateway and `normalizePath` in the
 * browser, each of which resolves a path against a root and refuses anything
 * that escapes it. This is the cheap layer in front of them — it rejects the
 * obviously hostile shape before a frame is allocated, so a traversal attempt
 * never reaches the code that would have to reject it anyway.
 */
function relativePath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ProtocolError(`${field} must be a string`);
  if (value.length === 0 || value.length > LIMITS.maxPathLength) {
    throw new ProtocolError(`${field} is not a valid path`);
  }
  // Absolute, drive-relative, Windows-separated, or containing a traversal
  // segment, a NUL, or any other control character.
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new ProtocolError(`${field} is not a valid path`);
  }
  return value;
}

/** A content hash as this protocol writes them: 32 lowercase hex characters. */
const HASH = /^[0-9a-f]{32}$/;

function hash(frame: Record<string, unknown>, field: string): string {
  const value = str(frame, field, 64);
  if (!HASH.test(value)) throw new ProtocolError(`${field} is not a content hash`);
  return value;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${field} must be an array`);
  if (value.length > max) throw new ProtocolError(`${field} has too many entries`);
  return value;
}

/** Base64 with no whitespace, bounded before it is decoded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function base64(frame: Record<string, unknown>, field: string, maxDecodedBytes: number): string {
  const value = str(frame, field, Math.ceil((maxDecodedBytes * 4) / 3) + 8);
  if (!BASE64.test(value)) throw new ProtocolError(`${field} is not base64`);
  return value;
}

/**
 * Parse one frame from a client.
 *
 * Throws {@link ProtocolError} for anything it does not recognise, which the
 * server turns into a fatal `PROTOCOL_ERROR` and a closed socket. There is no
 * lenient path: a client that sends a frame this does not understand is either
 * broken or probing, and both are handled the same way.
 */
export function parseClientFrame(raw: string): ClientFrame {
  if (raw.length > LIMITS.maxFrameBytes) throw new ProtocolError('frame is too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('frame is not valid JSON');
  }
  if (!isRecord(parsed)) throw new ProtocolError('frame must be an object');

  const type = parsed.type;
  switch (type) {
    case 'hello':
      return {
        type: 'hello',
        protocol: int(parsed, 'protocol', 0, 1000),
        // Bounded but not pattern-checked: a JWT's shape is Supabase's business,
        // and this must not become a second, weaker token validator.
        token: str(parsed, 'token', 8192),
        projectId: id(parsed, 'projectId'),
        sessionId: parsed.sessionId === undefined ? undefined : id(parsed, 'sessionId'),
        lastSeq: parsed.lastSeq === undefined ? undefined : int(parsed, 'lastSeq', 0, 2 ** 48),
        cols: parsed.cols === undefined ? undefined : int(parsed, 'cols', 1, LIMITS.maxCols),
        rows: parsed.rows === undefined ? undefined : int(parsed, 'rows', 1, LIMITS.maxRows),
      };

    case 'input':
      return {
        type: 'input',
        sessionId: id(parsed, 'sessionId'),
        data: base64(parsed, 'data', LIMITS.maxInputBytes),
      };

    case 'resize':
      return {
        type: 'resize',
        sessionId: id(parsed, 'sessionId'),
        cols: int(parsed, 'cols', 1, LIMITS.maxCols),
        rows: int(parsed, 'rows', 1, LIMITS.maxRows),
      };

    case 'signal': {
      const signal = str(parsed, 'signal', 16);
      if (!['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'].includes(signal)) {
        throw new ProtocolError('unsupported signal');
      }
      return { type: 'signal', sessionId: id(parsed, 'sessionId'), signal: signal as SignalFrame['signal'] };
    }

    case 'detach':
      return {
        type: 'detach',
        sessionId: id(parsed, 'sessionId'),
        kill: parsed.kill === undefined ? false : parsed.kill === true,
      };

    case 'ping':
      return { type: 'ping', at: int(parsed, 'at', 0, 2 ** 48) };

    case 'sync-manifest':
      return {
        type: 'sync-manifest',
        containerId: id(parsed, 'containerId'),
        files: array(parsed.files, 'files', LIMITS.maxManifestFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('manifest entry is invalid');
          return {
            path: relativePath(entry.path, 'path'),
            hash: hash(entry, 'hash'),
            size: int(entry, 'size', 0, 2 ** 32),
          };
        }),
      };

    case 'sync-push':
      return {
        type: 'sync-push',
        containerId: id(parsed, 'containerId'),
        files: array(parsed.files, 'files', LIMITS.maxSyncBatchFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('push entry is invalid');
          return {
            path: relativePath(entry.path, 'path'),
            content: str(entry, 'content', LIMITS.maxSyncFileBytes),
            baseHash: entry.baseHash === undefined ? undefined : hash(entry, 'baseHash'),
          };
        }),
      };

    case 'sync-delete':
      return {
        type: 'sync-delete',
        containerId: id(parsed, 'containerId'),
        paths: array(parsed.paths, 'paths', LIMITS.maxSyncBatchFiles).map((path) =>
          relativePath(path, 'path'),
        ),
      };

    default:
      throw new ProtocolError(`unknown frame type: ${typeof type === 'string' ? type.slice(0, 32) : 'none'}`);
  }
}

/**
 * Parse one frame from the gateway.
 *
 * The browser validates too. A gateway is more trusted than a browser, but
 * "more trusted" is not "trusted": these frames drive an editor, and a frame
 * that arrived malformed should be dropped rather than half-applied.
 */
export function parseServerFrame(raw: string): ServerFrame {
  if (raw.length > LIMITS.maxFrameBytes) throw new ProtocolError('frame is too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('frame is not valid JSON');
  }
  if (!isRecord(parsed)) throw new ProtocolError('frame must be an object');

  switch (parsed.type) {
    case 'ready':
      return {
        type: 'ready',
        protocol: int(parsed, 'protocol', 0, 1000),
        sessionId: id(parsed, 'sessionId'),
        containerId: id(parsed, 'containerId'),
        status: containerStatus(parsed.status),
        runtime: str(parsed, 'runtime', 64),
        resumed: parsed.resumed === true,
        seq: int(parsed, 'seq', 0, 2 ** 48),
      };

    case 'output':
      return {
        type: 'output',
        sessionId: id(parsed, 'sessionId'),
        seq: int(parsed, 'seq', 0, 2 ** 48),
        data: base64(parsed, 'data', LIMITS.maxOutputBytes),
      };

    case 'exit':
      return {
        type: 'exit',
        sessionId: id(parsed, 'sessionId'),
        exitCode: parsed.exitCode === null ? null : int(parsed, 'exitCode', -1, 255),
        signal: parsed.signal === null ? null : str(parsed, 'signal', 16),
      };

    case 'status':
      return {
        type: 'status',
        containerId: id(parsed, 'containerId'),
        status: containerStatus(parsed.status),
        detail: optionalStr(parsed, 'detail', 400),
      };

    case 'ports': {
      const ports = parsed.ports;
      if (!Array.isArray(ports) || ports.length > 64) throw new ProtocolError('ports is invalid');
      return {
        type: 'ports',
        containerId: id(parsed, 'containerId'),
        ports: ports.map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('port entry is invalid');
          return {
            port: int(entry, 'port', 1, 65535),
            url: str(entry, 'url', 2048),
            protocol: 'http' as const,
          };
        }),
      };
    }

    case 'error':
      return {
        type: 'error',
        code: errorCode(parsed.code),
        message: str(parsed, 'message', 400),
        sessionId: parsed.sessionId === undefined ? undefined : id(parsed, 'sessionId'),
        fatal: parsed.fatal === true,
      };

    case 'pong':
      return { type: 'pong', at: int(parsed, 'at', 0, 2 ** 48) };

    case 'sync-plan':
      return {
        type: 'sync-plan',
        containerId: id(parsed, 'containerId'),
        needed: array(parsed.needed, 'needed', LIMITS.maxManifestFiles).map((path) =>
          relativePath(path, 'path'),
        ),
        diverged: array(parsed.diverged, 'diverged', LIMITS.maxManifestFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('diverged entry is invalid');
          return { path: relativePath(entry.path, 'path'), containerHash: hash(entry, 'containerHash') };
        }),
        skipped: array(parsed.skipped, 'skipped', LIMITS.maxManifestFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('skipped entry is invalid');
          return { path: relativePath(entry.path, 'path'), reason: str(entry, 'reason', 200) };
        }),
        stale: array(parsed.stale, 'stale', LIMITS.maxManifestFiles).map((path) =>
          relativePath(path, 'path'),
        ),
      };

    case 'sync-ack':
      return {
        type: 'sync-ack',
        containerId: id(parsed, 'containerId'),
        results: array(parsed.results, 'results', LIMITS.maxSyncBatchFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('result entry is invalid');
          const path = relativePath(entry.path, 'path');
          switch (entry.status) {
            case 'written':
            case 'unchanged':
              return { status: entry.status, path, hash: hash(entry, 'hash') };
            case 'skipped':
              return { status: 'skipped' as const, path, reason: str(entry, 'reason', 200) };
            case 'conflict':
              return {
                status: 'conflict' as const,
                path,
                containerHash: hash(entry, 'containerHash'),
                editorHash: hash(entry, 'editorHash'),
              };
            default:
              throw new ProtocolError('unknown sync result status');
          }
        }),
      };

    case 'sync-changed':
      return {
        type: 'sync-changed',
        containerId: id(parsed, 'containerId'),
        files: array(parsed.files, 'files', LIMITS.maxSyncBatchFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('changed entry is invalid');
          return {
            path: relativePath(entry.path, 'path'),
            content: str(entry, 'content', LIMITS.maxSyncFileBytes),
            hash: hash(entry, 'hash'),
          };
        }),
        deleted: array(parsed.deleted, 'deleted', LIMITS.maxSyncBatchFiles).map((path) =>
          relativePath(path, 'path'),
        ),
      };

    case 'sync-storm':
      return {
        type: 'sync-storm',
        containerId: id(parsed, 'containerId'),
        count: int(parsed, 'count', 0, 2 ** 32),
      };

    default:
      throw new ProtocolError('unknown frame type');
  }
}

const STATUSES: readonly string[] = [
  'creating',
  'starting',
  'ready',
  'stopping',
  'stopped',
  'error',
  'expired',
];

function containerStatus(value: unknown): ContainerStatus {
  if (typeof value !== 'string' || !STATUSES.includes(value)) {
    throw new ProtocolError('unknown container status');
  }
  return value as ContainerStatus;
}

const CODES: readonly string[] = [
  'AUTH_ERROR',
  'PERMISSION_ERROR',
  'CONTAINER_ERROR',
  'PTY_ERROR',
  'SYNC_ERROR',
  'PORT_ERROR',
  'RESOURCE_LIMIT',
  'TIMEOUT',
  'PROTOCOL_ERROR',
  'INTERNAL_ERROR',
];

function errorCode(value: unknown): ErrorCode {
  if (typeof value !== 'string' || !CODES.includes(value)) return 'INTERNAL_ERROR';
  return value as ErrorCode;
}

/** Encode a frame for the wire. Separate so the size cap is applied in one place. */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  const text = JSON.stringify(frame);
  if (text.length > LIMITS.maxFrameBytes) {
    throw new ProtocolError(`frame of type ${frame.type} exceeds the size limit`);
  }
  return text;
}
