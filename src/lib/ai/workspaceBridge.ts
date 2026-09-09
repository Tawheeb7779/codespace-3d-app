import type { ContainerTerminal } from '@/lib/terminal/containerClient';
import type { GitOperation } from '@/lib/terminal/protocol';

/**
 * The agent's connection to the real workspace, and its limits.
 *
 * The agent already reads and writes project files, runs the in-browser shell
 * and compiles through the in-browser bundler. All of that is real, and none of
 * it is the *project's own* environment: the bundler is not `npm test`, and a
 * simulated shell is not Node. This bridge is how the agent reaches the
 * container from Phase 2 — real git state, and the project's real checks.
 *
 * **What it deliberately is not.** There is no method here that runs a command
 * the agent chose. The gateway exposes typed git operations and a five-name
 * check allowlist, and this passes those through; it adds no capability of its
 * own. An agent that could run a shell in the container would be an agent with
 * the user's whole toolchain, and "the model decided to" is not an authorisation
 * decision.
 *
 * **It reports absence rather than inventing presence.** With no gateway
 * configured, or no project terminal open, every call returns a result saying
 * so. That is the difference between an agent that says "I could not run the
 * tests because no workspace is connected" and one that claims they passed.
 *
 * The Git panel uses the same door. Its operations are wider than the agent's —
 * a person may commit and switch branches, and the agent may not — but they are
 * the same typed operations the gateway already validates, and the widening is
 * in which of them each caller offers, not in what this module can express.
 */

/** The subset of the terminal client this bridge uses. */
type Bridgeable = Pick<ContainerTerminal, 'git' | 'check' | 'containerId'>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long the agent waits for one answer.
 *
 * Generous for a check — a real test suite is not fast — and the gateway
 * enforces its own shorter bound on git. A request that outlives this is
 * abandoned rather than left to leak: the entry is removed and the caller is
 * told, so a lost frame cannot strand a turn forever.
 */
const GIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 200_000;

/**
 * The project terminal's client, when one is connected.
 *
 * A module-level slot rather than a store, because there is exactly one project
 * container per open project and the agent has no use for a second. Registering
 * a Linux workspace here would be a mistake and is refused by the caller: the
 * agent works on the project, and a Linux workspace is not the project.
 */
let connected: Bridgeable | null = null;
const pending = new Map<string, Pending>();
const watchers = new Set<() => void>();

/**
 * The container id last announced to watchers.
 *
 * The client object survives a reconnect but its container may not: a rebuilt
 * workspace is a different container with a different repository, registered
 * through the same object. Comparing only the object would leave a watcher
 * rendering the previous container's state, so the id is part of what "changed"
 * means here.
 */
let announced: string | null = null;

/** Called by the project terminal when its client becomes usable. */
export function registerProjectWorkspace(client: Bridgeable | null): void {
  const nextId = client?.containerId ?? null;
  const changed = connected !== client || announced !== nextId;
  connected = client;
  announced = nextId;
  if (!client) {
    // Whatever was in flight belongs to a connection that is gone.
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The workspace disconnected.'));
    }
    pending.clear();
  }
  if (changed) for (const watcher of watchers) watcher();
}

/** Whether the agent currently has a real workspace to work in. */
export function workspaceConnected(): boolean {
  return connected !== null && connected.containerId !== null;
}

/**
 * Watch for the workspace appearing or going away.
 *
 * The Git panel needs this for the same reason the agent needs the bridge at
 * all: it must show what is *there*, and a panel that renders a stale branch
 * name after the terminal closed is reporting a state it can no longer read.
 * Shaped for `useSyncExternalStore`, so a component subscribes rather than
 * polls.
 */
export function subscribeWorkspace(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/**
 * The connected workspace's container id, or null.
 *
 * A stable value while one workspace is attached, so it can key a component's
 * effect: a new container is a different repository, and its state must be
 * re-read rather than carried over.
 */
export function workspaceContainerId(): string | null {
  return connected?.containerId ?? null;
}

/** Deliver an answer. Called by the terminal component from its frame handlers. */
export function resolveWorkspaceRequest(requestId: string, value: unknown): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(value);
}

function awaitAnswer<T>(requestId: string | null, timeoutMs: number): Promise<T> {
  if (!requestId) {
    return Promise.reject(new Error('No container workspace is connected.'));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('The workspace did not answer in time.'));
    }, timeoutMs);
    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
  });
}

export interface WorkspaceGitResult {
  ok: boolean;
  data?: unknown;
  message?: string;
  needsConfirmation?: boolean;
  atRisk?: string[];
}

/**
 * Run a typed git operation in the project's container.
 *
 * Which operations a caller may use is the caller's own restraint rather than
 * this function's: the agent's tools expose only `status` and `diff`, while the
 * Git panel — driven by a person, in front of them — stages, commits and
 * switches branches. The gateway refuses an unconfirmed destructive operation
 * either way; the agent not offering one is the layer in front of that.
 */
export async function workspaceGit(request: GitOperation): Promise<WorkspaceGitResult> {
  if (!connected) return { ok: false, message: 'No container workspace is connected.' };
  const requestId = connected.git(request);
  return awaitAnswer<WorkspaceGitResult>(requestId, GIT_TIMEOUT_MS);
}

export interface WorkspaceCheckResult {
  ok: boolean;
  available?: string[];
  result?: { script: string; ok: boolean; exitCode: number; output: string; truncated: boolean };
  message?: string;
}

export async function workspaceCheck(
  request: { op: 'list' } | { op: 'run'; script: string },
): Promise<WorkspaceCheckResult> {
  if (!connected) return { ok: false, message: 'No container workspace is connected.' };
  const requestId = connected.check(request);
  return awaitAnswer<WorkspaceCheckResult>(
    requestId,
    request.op === 'run' ? CHECK_TIMEOUT_MS : GIT_TIMEOUT_MS,
  );
}

/** Requests still waiting. Exposed so a test can assert nothing is stranded. */
export function pendingRequestCount(): number {
  return pending.size;
}
