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
export const PROTOCOL_VERSION = 3;

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
  /** Files one explicit transfer may carry between workspaces. */
  maxTransferFiles: 200,
  /** Bytes of git output a single result frame may carry. */
  maxGitOutputBytes: 128 * 1024,
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
  /** A git operation that failed, or was refused because it would lose work. */
  | 'GIT_ERROR'
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
  /**
   * The project this terminal belongs to, or an empty string for a Linux
   * workspace.
   *
   * Two terminals, two authorisation paths. A `project` workspace is authorised
   * by membership of that project. A `linux` workspace belongs to the person
   * and is authorised by identity alone — project membership grants no access
   * to it, and it has no project id to check.
   */
  projectId: string;
  /** Which of TA CODE's two workspace concepts this is. Defaults to `project`. */
  kind?: 'project' | 'linux';
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
// Real Git
//
// A typed request, never an argument vector. The gateway builds every git
// command line itself, because git's *options* are what turn a subcommand
// allowlist into an illusion: `-c core.sshCommand=` runs a program,
// `--git-dir=` chooses any path, `-C` leaves the workspace. None of those can
// be expressed in the shapes below.
// ---------------------------------------------------------------------------

export type GitOperation =
  | { op: 'status' }
  | { op: 'log'; limit?: number }
  | { op: 'diff'; staged?: boolean; path?: string }
  | { op: 'branches' }
  | { op: 'show'; ref: string }
  | { op: 'rev-parse'; ref: string }
  | { op: 'remotes' }
  | { op: 'init' }
  | { op: 'add'; paths: string[] }
  | { op: 'unstage'; paths: string[] }
  | { op: 'commit'; message: string }
  | { op: 'create-branch'; name: string }
  /** Destructive. Refused unless `confirm` is true and nothing would be lost. */
  | { op: 'checkout'; ref: string; confirm?: boolean }
  | { op: 'discard'; paths: string[]; confirm?: boolean }
  | { op: 'delete-branch'; name: string; confirm?: boolean };

export interface GitFrame {
  type: 'git';
  /** Correlates the answer, because several may be in flight. */
  requestId: string;
  containerId: string;
  request: GitOperation;
}

export interface GitResultFrame {
  type: 'git-result';
  requestId: string;
  containerId: string;
  /** The operation's result, shaped by its `op`. Opaque to the protocol. */
  ok: boolean;
  /** Present when ok; JSON-serialisable and bounded by `maxGitOutputBytes`. */
  data?: unknown;
  /** Present when not ok. Safe for a person to read. */
  message?: string;
  /**
   * Set when the refusal was a safety refusal rather than a failure.
   *
   * The client uses it to offer a confirmation rather than an error: the
   * operation did not fail, it declined to destroy something.
   */
  needsConfirmation?: boolean;
  /** Paths that would be lost, so a person is told what and not merely that. */
  atRisk?: string[];
}

// ---------------------------------------------------------------------------
// Explicit transfer between a project and a Linux workspace
//
// Never a mount, never automatic, never a whole tree by default. A person names
// files and a direction; both endpoints are authorised independently.
// ---------------------------------------------------------------------------

export interface TransferFrame {
  type: 'transfer';
  requestId: string;
  /** The workspace the files come from. */
  fromContainerId: string;
  /** The workspace they go to. */
  toContainerId: string;
  paths: string[];
  /**
   * Whether an existing file at the destination may be replaced.
   *
   * Default false, and a conflict is reported rather than resolved: the two
   * workspaces are independent, so the gateway has no basis for deciding which
   * copy somebody wanted.
   */
  overwrite?: boolean;
}

export interface TransferResultFrame {
  type: 'transfer-result';
  requestId: string;
  copied: string[];
  /** Paths that already existed at the destination and were left alone. */
  conflicts: string[];
  /** Paths refused, with the reason — protected, too large, or invalid. */
  skipped: Array<{ path: string; reason: string }>;
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
  | SyncDeleteFrame
  | GitFrame
  | TransferFrame;

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
  | SyncStormFrame
  | GitResultFrame
  | TransferResultFrame;

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

/**
 * One git operation, validated into a shape the gateway can act on.
 *
 * Every field is checked here rather than in the gateway, so a malformed or
 * hostile request is refused before it reaches code that builds a command line.
 * Paths use `relativePath`, which is the same syntactic screen the sync frames
 * use — the real boundary is `normalizePath` on the gateway, which this sits in
 * front of rather than replaces.
 */
function gitOperation(value: unknown): GitOperation {
  if (!isRecord(value)) throw new ProtocolError('git request is invalid');
  const paths = (): string[] =>
    array(value.paths, 'paths', LIMITS.maxSyncBatchFiles).map((path) =>
      relativePath(path, 'path'),
    );
  // Bounded, and not pattern-checked: what a valid ref looks like is git's
  // business, and the gateway asks `check-ref-format` rather than guessing.
  const ref = (field: string): string => str(value, field, 255);

  switch (value.op) {
    case 'status':
    case 'branches':
    case 'remotes':
    case 'init':
      return { op: value.op };
    case 'log':
      return { op: 'log', limit: value.limit === undefined ? undefined : int(value, 'limit', 1, 500) };
    case 'diff':
      return {
        op: 'diff',
        staged: value.staged === true,
        path: value.path === undefined ? undefined : relativePath(value.path, 'path'),
      };
    case 'show':
      return { op: 'show', ref: ref('ref') };
    case 'rev-parse':
      return { op: 'rev-parse', ref: ref('ref') };
    case 'add':
      return { op: 'add', paths: paths() };
    case 'unstage':
      return { op: 'unstage', paths: paths() };
    case 'commit':
      return { op: 'commit', message: str(value, 'message', 4000) };
    case 'create-branch':
      return { op: 'create-branch', name: ref('name') };
    case 'checkout':
      return { op: 'checkout', ref: ref('ref'), confirm: value.confirm === true };
    case 'discard':
      return { op: 'discard', paths: paths(), confirm: value.confirm === true };
    case 'delete-branch':
      return { op: 'delete-branch', name: ref('name'), confirm: value.confirm === true };
    default:
      throw new ProtocolError('unknown git operation');
  }
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
        // A Linux workspace has no project, and sends an empty string rather
        // than a placeholder id that could later collide with a real one.
        projectId: parsed.projectId === '' ? '' : id(parsed, 'projectId'),
        kind: parsed.kind === 'linux' ? 'linux' : 'project',
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

    case 'git':
      return {
        type: 'git',
        requestId: id(parsed, 'requestId'),
        containerId: id(parsed, 'containerId'),
        request: gitOperation(parsed.request),
      };

    case 'transfer':
      return {
        type: 'transfer',
        requestId: id(parsed, 'requestId'),
        fromContainerId: id(parsed, 'fromContainerId'),
        toContainerId: id(parsed, 'toContainerId'),
        paths: array(parsed.paths, 'paths', LIMITS.maxTransferFiles).map((path) =>
          relativePath(path, 'path'),
        ),
        overwrite: parsed.overwrite === true,
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

    case 'git-result':
      return {
        type: 'git-result',
        requestId: id(parsed, 'requestId'),
        containerId: id(parsed, 'containerId'),
        ok: parsed.ok === true,
        data: parsed.data,
        message: optionalStr(parsed, 'message', 400),
        needsConfirmation: parsed.needsConfirmation === true,
        atRisk:
          parsed.atRisk === undefined
            ? undefined
            : array(parsed.atRisk, 'atRisk', LIMITS.maxTransferFiles).map((path) =>
                relativePath(path, 'path'),
              ),
      };

    case 'transfer-result':
      return {
        type: 'transfer-result',
        requestId: id(parsed, 'requestId'),
        copied: array(parsed.copied, 'copied', LIMITS.maxTransferFiles).map((path) =>
          relativePath(path, 'path'),
        ),
        conflicts: array(parsed.conflicts, 'conflicts', LIMITS.maxTransferFiles).map((path) =>
          relativePath(path, 'path'),
        ),
        skipped: array(parsed.skipped, 'skipped', LIMITS.maxTransferFiles).map((entry) => {
          if (!isRecord(entry)) throw new ProtocolError('skipped entry is invalid');
          return { path: relativePath(entry.path, 'path'), reason: str(entry, 'reason', 200) };
        }),
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
  'GIT_ERROR',
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
