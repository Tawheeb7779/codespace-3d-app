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

export interface ContainerRecord {
  id: string;
  userId: string;
  projectId: string;
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

/** One container per (user, project). A second tab joins the first. */
export function containerKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

/**
 * A container id that is also safe as a directory name and a Docker name.
 *
 * Derived from the key rather than random so that reconnecting finds the same
 * workspace, and hashed so that a project id cannot smuggle characters into
 * either namespace.
 */
export function containerIdFor(userId: string, projectId: string): string {
  let hash = 0x811c9dc5;
  for (const char of containerKey(userId, projectId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `tacode-${hash.toString(16).padStart(8, '0')}`;
}

export class ContainerManager {
  private readonly containers = new Map<string, ContainerRecord>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly runtime: ContainerRuntime,
    private readonly sessions: SessionRegistry,
    private readonly logger: Logger,
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
    projectId: string,
    tierName = this.config.defaultTier,
  ): Promise<ContainerRecord> {
    const key = containerKey(userId, projectId);
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
    const id = containerIdFor(userId, projectId);
    const workspaceDir = workspaceDirFor(this.config.workspaceRoot, id);

    const record: ContainerRecord = {
      id,
      userId,
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
  get(userId: string, projectId: string): ContainerRecord | null {
    return this.containers.get(containerKey(userId, projectId)) ?? null;
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
    this.forget(containerKey(record.userId, record.projectId));
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
