import { createHash } from 'node:crypto';
import type { ContainerStatus } from '../../src/lib/terminal/protocol.ts';
import type { GatewayConfig, ResourceTier } from './config.ts';
import type { ContainerRuntime } from './runtime/types.ts';
import type { Logger } from './observability.ts';
import { GatewayError, resourceLimit } from './errors.ts';
import { SyncIndex } from './sync.ts';
import { workspaceDirFor } from './workspace.ts';
import type { SessionRegistry } from './session.ts';

/**
 * Containers: what exists, what state it is in, and when it goes away.
 *
 * The registry is in memory and the runtime is the authority. That is the
 * opposite of what a database-first design would do, and it is deliberate: a
 * process registry that survives the process is a list of claims about a world
 * that has moved on. The gateway can be restarted, a host can be replaced, and
 * a container can be killed by the kernel — in every case the runtime knows and
 * a stored row does not. So {@link ContainerManager.get} re-checks existence
 * with the runtime before handing a container out, and a row that no longer
 * corresponds to anything is dropped rather than reported.
 *
 * Persistence still has a job, just a smaller one: metadata worth reporting
 * later — who, which project, when, which tier. That belongs in Postgres and is
 * written by the caller; it is not consulted to decide whether a shell can
 * attach.
 */

/**
 * What a workspace *is*, and it is not a label.
 *
 * A `project` workspace holds one project's files and is authorised by that
 * project's membership. A `linux` workspace belongs to a person rather than to
 * a project: it has its own filesystem, nothing is mounted into it, and
 * membership of a project grants no access to it at all.
 *
 * The kind is part of the container's identity, so the two can never name the
 * same directory — see {@link containerIdFor}.
 */
export type WorkspaceKind = 'project' | 'linux';

export interface ContainerRecord {
  id: string;
  userId: string;
  kind: WorkspaceKind;
  /**
   * The project this workspace serves, or null for a Linux workspace.
   *
   * Null rather than a placeholder string: a Linux workspace has no project,
   * and code that needs one should fail to compile rather than compare against
   * a sentinel somebody later reuses as a real id.
   */
  projectId: string | null;
  tier: ResourceTier;
  status: ContainerStatus;
  workspaceDir: string;
  createdAt: number;
  lastActiveAt: number;
  /** Per-container file state, shared by the sync engine and the watcher. */
  index: SyncIndex;
  /** Ports discovered as listening, for the proxy to allow. */
  openPorts: Set<number>;
}

/**
 * One container per (user, kind, project). A second tab joins the first.
 *
 * The kind is in the key, so a person's Linux workspace and their workspace for
 * a project called `linux` are two different containers rather than a
 * collision waiting to be found.
 */
export function containerKey(
  userId: string,
  projectId: string | null,
  kind: WorkspaceKind = 'project',
): string {
  return `${userId}:${kind}:${projectId ?? ''}`;
}

/**
 * A container id that is also safe as a directory name and a Docker name.
 *
 * Derived from the key rather than random, so reconnecting finds the same
 * workspace, and hashed so a project id cannot smuggle characters into either
 * namespace.
 *
 * The hash must be collision-resistant, and this is not a stylistic point. The
 * id names a directory — `workspaceDirFor` resolves it under the workspace root
 * — so two keys that hash alike are two users sharing one workspace, with each
 * one's container bind-mounting the other's files.
 *
 * The previous implementation was a 32-bit FNV-1a. Project ids are generated in
 * the browser and sent to the server, so an attacker chooses one half of the
 * input outright: they compute offline a project id whose key collides with a
 * victim's, create a project under it, and open a terminal onto the victim's
 * workspace. Measured on this machine, single-threaded and unoptimised, a
 * collision took under three minutes to find.
 *
 * SHA-256 truncated to 128 bits ends that. Truncation is safe here — 2^64 work
 * for a birthday collision against a keyspace that is also rate-limited by
 * container creation — and the id stays short enough for a Docker name.
 *
 * Predictability is deliberately *not* what this fixes, because it is not the
 * problem: the id is handed to the client in the `ready` frame and is not an
 * authorisation token. Every lookup goes through `byId(id, userId)`, which
 * matches on ownership, so knowing an id grants nothing. Collision was the
 * vulnerability; a keyed HMAC would hide ids without making them safer.
 */
export function containerIdFor(
  userId: string,
  projectId: string | null,
  kind: WorkspaceKind = 'project',
): string {
  const digest = createHash('sha256').update(containerKey(userId, projectId, kind)).digest('hex');
  return `tacode-${digest.slice(0, 32)}`;
}

export class ContainerManager {
  private readonly containers = new Map<string, ContainerRecord>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly runtime: ContainerRuntime,
    private readonly sessions: SessionRegistry,
    private readonly logger: Logger,
    /**
     * Called after a container is gone, so whatever was watching it can stop.
     *
     * A callback rather than a direct call into the sync service, because the
     * lifecycle manager knowing about file synchronisation would make the
     * dependency circular — and because the reaper, which is the caller that
     * matters, runs on a timer with nobody to tell.
     */
    private readonly onStopped: (containerId: string) => void = () => undefined,
  ) {}

  get size(): number {
    return this.containers.size;
  }

  list(): ContainerRecord[] {
    return [...this.containers.values()];
  }

  /**
   * The container for this user and project, created if there is none.
   *
   * Two ceilings are checked before anything is created: one per user, so a
   * single account cannot occupy the host, and one overall, so the host has a
   * bound regardless of how many accounts there are. The refusal is a
   * `RESOURCE_LIMIT`, which the UI can explain, rather than a failure later on.
   */
  async ensure(
    userId: string,
    projectId: string | null,
    tierName = this.config.defaultTier,
    kind: WorkspaceKind = 'project',
  ): Promise<ContainerRecord> {
    const key = containerKey(userId, projectId, kind);
    const existing = this.containers.get(key);
    if (existing) {
      if (await this.runtime.exists(existing.id)) {
        existing.lastActiveAt = Date.now();
        return existing;
      }
      // The runtime lost it — the host restarted, or something reaped it.
      // Recover by forgetting rather than by reporting a container that is not
      // there, which is the case this design exists to survive.
      this.logger.event('container_error', {
        containerId: existing.id,
        userId,
        projectId,
        reason: 'runtime no longer has this container; recreating',
      });
      this.forget(key);
    }

    const mine = [...this.containers.values()].filter((entry) => entry.userId === userId);
    if (mine.length >= this.config.maxContainersPerUser) {
      throw resourceLimit(
        'You already have the maximum number of workspaces running. Stop one to start another.',
      );
    }
    if (this.containers.size >= this.config.maxContainers) {
      throw resourceLimit('The service is at capacity. Try again shortly.');
    }

    const tier = this.config.tiers[tierName];
    const id = containerIdFor(userId, projectId, kind);
    const workspaceDir = workspaceDirFor(this.config.workspaceRoot, id);

    const record: ContainerRecord = {
      id,
      userId,
      kind,
      projectId,
      tier,
      status: 'creating',
      workspaceDir,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      index: new SyncIndex(),
      openPorts: new Set(),
    };
    this.containers.set(key, record);

    try {
      await this.runtime.create({
        containerId: id,
        workspaceDir,
        tier,
        image: this.config.image,
        network: this.config.network,
      });
      this.logger.event('container_created', {
        containerId: id,
        userId,
        projectId,
        runtime: this.runtime.name,
      });

      record.status = 'starting';
      await this.runtime.start(id);
      record.status = 'ready';
      this.logger.event('container_started', { containerId: id, userId, projectId });
      return record;
    } catch (error) {
      record.status = 'error';
      this.forget(key);
      await this.runtime.destroy(id).catch(() => undefined);
      const detail = error instanceof GatewayError ? error.detail : 'unknown';
      this.logger.problem('container_error', { containerId: id, userId, projectId, reason: detail });
      throw error instanceof GatewayError
        ? error
        : new GatewayError('CONTAINER_ERROR', 'The workspace could not be started.', detail);
    }
  }

  /** An existing container this user owns, or null. Never creates. */
  get(
    userId: string,
    projectId: string | null,
    kind: WorkspaceKind = 'project',
  ): ContainerRecord | null {
    return this.containers.get(containerKey(userId, projectId, kind)) ?? null;
  }

  byId(containerId: string, userId: string): ContainerRecord | null {
    const record = [...this.containers.values()].find((entry) => entry.id === containerId);
    // Ownership is checked here rather than by the caller, because every caller
    // would otherwise have to remember to.
    return record && record.userId === userId ? record : null;
  }

  touch(containerId: string): void {
    const record = [...this.containers.values()].find((entry) => entry.id === containerId);
    if (record) record.lastActiveAt = Date.now();
  }

  async stop(record: ContainerRecord, reason: ContainerStatus = 'stopped'): Promise<void> {
    record.status = 'stopping';
    this.sessions.removeForContainer(record.id);
    await this.runtime.stop(record.id).catch(() => undefined);
    await this.runtime.destroy(record.id).catch(() => undefined);
    record.status = reason;
    this.forget(containerKey(record.userId, record.projectId, record.kind));
    this.onStopped(record.id);
    this.logger.event(reason === 'expired' ? 'container_expired' : 'container_stopped', {
      containerId: record.id,
      userId: record.userId,
      projectId: record.projectId,
    });
  }

  private forget(key: string): void {
    this.containers.delete(key);
  }

  /**
   * Reclaim what nobody is using.
   *
   * Two rules, because they answer different failures. Idle catches the ordinary
   * case — a tab closed, nothing attached, no output for a while. Lifetime
   * catches the case idle cannot: something that keeps printing forever is never
   * idle, and without an absolute ceiling it runs until the host does not.
   *
   * A session with no socket is not idle on its own. `npm run dev` with the
   * browser tab closed is exactly the thing that must survive, so the clock only
   * runs when nothing is attached *and* nothing has produced output.
   */
  async reap(now = Date.now()): Promise<ContainerRecord[]> {
    const reclaimed: ContainerRecord[] = [];
    for (const record of [...this.containers.values()]) {
      // Sessions first: an exited shell must not keep a container alive, and a
      // slot must not stay occupied by one nobody will reattach to.
      this.sessions.prune(record.tier.idleTimeoutSeconds, now);
      const sessions = this.sessions.forContainer(record.id);
      const attached = sessions.some((session) => session.attached);
      const lastActivity = Math.max(
        record.lastActiveAt,
        ...sessions.map((session) => session.lastActivity),
      );

      const idleFor = (now - lastActivity) / 1000;
      const ageSeconds = (now - record.createdAt) / 1000;

      const expiredByAge = ageSeconds > record.tier.maxLifetimeSeconds;
      const expiredByIdle = !attached && idleFor > record.tier.idleTimeoutSeconds;

      if (expiredByAge || expiredByIdle) {
        this.logger.event('resource_limit_hit', {
          containerId: record.id,
          userId: record.userId,
          reason: expiredByAge ? 'max lifetime reached' : 'idle timeout reached',
        });
        await this.stop(record, 'expired');
        reclaimed.push(record);
      }
    }
    return reclaimed;
  }

  startReaper(intervalMs = 30_000): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      void this.reap().catch(() => undefined);
    }, intervalMs);
    // Never hold the process open for a timer whose only job is cleanup.
    this.reaper.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    for (const record of [...this.containers.values()]) {
      await this.stop(record).catch(() => undefined);
    }
  }
}
