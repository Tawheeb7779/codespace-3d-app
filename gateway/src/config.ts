/**
 * Everything an operator can turn, in one place.
 *
 * Read once at startup and passed down, rather than read from `process.env` at
 * the point of use: a limit that is read lazily is a limit that can be observed
 * to change halfway through a request, and a config that is assembled in one
 * function is a config a test can construct without touching the environment.
 */

export type TierName = 'free' | 'pro';

/**
 * What a workspace is allowed to consume.
 *
 * These are enforced by the container runtime — cgroups and pids limits — not
 * by the gateway counting things in JavaScript. Application-level limits are a
 * politeness; a fork bomb does not read them.
 */
export interface ResourceTier {
  name: TierName;
  /** Fractional CPUs, e.g. 0.5 of one core. */
  cpus: number;
  memoryMb: number;
  /** Writable layer size. Enforced by the storage driver where it supports it. */
  diskMb: number;
  /** Hard ceiling on processes, which is what actually stops a fork bomb. */
  pids: number;
  /** Seconds with no attached terminal before the container is reclaimed. */
  idleTimeoutSeconds: number;
  /** Absolute lifetime, so nothing runs forever because something kept polling. */
  maxLifetimeSeconds: number;
  /** Concurrent terminal sessions per container. */
  maxSessions: number;
}

const TIERS: Record<TierName, ResourceTier> = {
  free: {
    name: 'free',
    cpus: 0.5,
    memoryMb: 512,
    diskMb: 2048,
    pids: 128,
    idleTimeoutSeconds: 15 * 60,
    maxLifetimeSeconds: 4 * 60 * 60,
    maxSessions: 3,
  },
  pro: {
    name: 'pro',
    cpus: 2,
    memoryMb: 4096,
    diskMb: 16384,
    pids: 512,
    idleTimeoutSeconds: 60 * 60,
    maxLifetimeSeconds: 24 * 60 * 60,
    maxSessions: 10,
  },
};

export interface GatewayConfig {
  port: number;
  /** Supabase project URL. Identity is verified against this and nothing else. */
  supabaseUrl: string;
  supabaseServiceKey: string;
  /** Which runtime backs a workspace. */
  runtime: 'docker' | 'local';
  /** Image used by the docker runtime. Pinned by digest in production. */
  image: string;
  /** Where workspaces live on the host. One directory per container. */
  workspaceRoot: string;
  /** Origins allowed to open a terminal. `*` only makes sense in development. */
  allowedOrigins: string[];
  tiers: Record<TierName, ResourceTier>;
  defaultTier: TierName;
  /** Containers in total. A ceiling on the host, independent of per-user limits. */
  maxContainers: number;
  /** Containers one user may hold at once. */
  maxContainersPerUser: number;
  /** Ports inside a container that may be proxied. */
  allowedPorts: number[];
  /**
   * Outbound network policy for a workspace.
   *
   * `none` is the safe default for an untrusted workload; `full` is what makes
   * `npm install` work. An operator chooses, and the choice is visible in the
   * container's creation arguments rather than buried in an image.
   */
  network: 'none' | 'full';
  /** Bytes of a single file the sync layer will move. */
  maxSyncFileBytes: number;
  /** Files in one sync batch. */
  maxSyncFiles: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Overrides for one tier.
 *
 * `env` is threaded through rather than read from `process.env` here. It looked
 * harmless and it was not: `loadConfig(env)` claimed to be a pure function of
 * its argument while quietly reading the ambient environment for exactly the
 * values an operator is most likely to tune, so a limit set in a test — or in a
 * config assembled any way but from the real environment — was silently
 * ignored.
 */
function tierFromEnv(env: NodeJS.ProcessEnv, base: ResourceTier, prefix: string): ResourceTier {
  return {
    ...base,
    cpus: Number(env[`${prefix}_CPUS`] ?? base.cpus) || base.cpus,
    memoryMb: int(env, `${prefix}_MEMORY_MB`, base.memoryMb),
    diskMb: int(env, `${prefix}_DISK_MB`, base.diskMb),
    pids: int(env, `${prefix}_PIDS`, base.pids),
    idleTimeoutSeconds: int(env, `${prefix}_IDLE_SECONDS`, base.idleTimeoutSeconds),
    maxLifetimeSeconds: int(env, `${prefix}_MAX_LIFETIME_SECONDS`, base.maxLifetimeSeconds),
    maxSessions: int(env, `${prefix}_MAX_SESSIONS`, base.maxSessions),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const runtime = env.TACODE_RUNTIME === 'local' ? 'local' : 'docker';
  return {
    port: int(env, 'PORT', 8080),
    supabaseUrl: (env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    runtime,
    image: env.TACODE_IMAGE ?? 'ta-code/workspace:1',
    workspaceRoot: env.TACODE_WORKSPACE_ROOT ?? '/var/lib/ta-code/workspaces',
    allowedOrigins: (env.TACODE_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    tiers: {
      free: tierFromEnv(env, TIERS.free, 'TACODE_FREE'),
      pro: tierFromEnv(env, TIERS.pro, 'TACODE_PRO'),
    },
    defaultTier: env.TACODE_DEFAULT_TIER === 'pro' ? 'pro' : 'free',
    maxContainers: int(env, 'TACODE_MAX_CONTAINERS', 50),
    maxContainersPerUser: int(env, 'TACODE_MAX_CONTAINERS_PER_USER', 2),
    allowedPorts: (env.TACODE_ALLOWED_PORTS ?? '3000,4000,5000,5173,8000,8080,8081')
      .split(',')
      .map((entry) => Number(entry.trim()))
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
    network: env.TACODE_NETWORK === 'full' ? 'full' : 'none',
    maxSyncFileBytes: int(env, 'TACODE_MAX_SYNC_FILE_BYTES', 2 * 1024 * 1024),
    maxSyncFiles: int(env, 'TACODE_MAX_SYNC_FILES', 20_000),
  };
}

/** Reasons this process must not start. Checked once, loudly, at boot. */
export function configProblems(config: GatewayConfig): string[] {
  const problems: string[] = [];
  if (!config.supabaseUrl) problems.push('SUPABASE_URL is not set; no caller could be authenticated.');
  if (!config.supabaseServiceKey) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set.');
  if (!config.workspaceRoot.startsWith('/')) problems.push('TACODE_WORKSPACE_ROOT must be absolute.');
  if (config.runtime === 'local' && process.env.NODE_ENV === 'production') {
    problems.push(
      'TACODE_RUNTIME=local provides no isolation and must not be used in production.',
    );
  }
  return problems;
}
