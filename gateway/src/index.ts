import { mkdir } from 'node:fs/promises';
import { configProblems, loadConfig } from './config.ts';
import { createAuthorizer } from './auth.ts';
import { createLogger } from './observability.ts';
import { createGateway } from './server.ts';
import { createDockerRuntime } from './runtime/docker.ts';
import { createLocalRuntime } from './runtime/local.ts';
import type { ContainerRuntime } from './runtime/types.ts';

/**
 * Boot.
 *
 * Everything that can be wrong with the configuration is decided here, before a
 * socket is accepted, and any of it stops the process. A gateway that starts
 * with no way to authenticate anybody, or with the development runtime in
 * production, is worse than one that does not start: it looks like it is
 * working.
 */

const config = loadConfig();
const logger = createLogger();

const problems = configProblems(config);
if (problems.length) {
  for (const problem of problems) logger.problem('container_error', { reason: problem });
  process.exit(1);
}

/**
 * What the runtime turned out to be able to enforce.
 *
 * Reported at boot rather than discovered from a support ticket. A disk quota
 * the daemon cannot apply is a real reduction in isolation — one workspace can
 * fill the host's disk and take every other workspace down with it — and the
 * one thing that must not happen is for it to be silently absent while the
 * configuration still names a `DISK_MB`.
 */
let capabilities = { diskQuota: false };

const runtime: ContainerRuntime =
  config.runtime === 'local'
    ? createLocalRuntime()
    : createDockerRuntime({
        useGvisor: process.env.TACODE_GVISOR === '1',
        // The operator's own pinned image, so the quota probe pulls nothing.
        image: config.image,
        timeoutMs: config.runtimeTimeoutMs,
        onCapabilities: (reported) => {
          capabilities = reported;
        },
      });

if (!(await runtime.available())) {
  logger.problem('container_error', {
    runtime: runtime.name,
    reason: 'the container runtime is not available; refusing to start',
  });
  process.exit(1);
}

if (runtime.name === 'docker' && !capabilities.diskQuota) {
  // A warning an operator will actually see, naming the consequence rather
  // than the flag. Never silently downgraded: the tier still advertises a disk
  // size, and nothing is enforcing it.
  logger.problem('resource_limit_hit', {
    runtime: runtime.name,
    reason:
      'per-container disk quota is NOT enforced on this host (overlay2 needs XFS with pquota); ' +
      'TACODE_*_DISK_MB is advertised but unenforced, and one workspace can fill the host disk',
  });
}

if (!runtime.isolates && process.env.NODE_ENV === 'production') {
  logger.problem('container_error', {
    runtime: runtime.name,
    reason: 'this runtime provides no isolation and must not serve production traffic',
  });
  process.exit(1);
}

await mkdir(config.workspaceRoot, { recursive: true });

const gateway = createGateway({
  config,
  runtime,
  authorizer: createAuthorizer(config),
  logger,
});

gateway.server.listen(config.port, () => {
  logger.event('gateway_started', {
    runtime: runtime.name,
    reason: `listening on ${config.port}`,
  });
});

/**
 * Stop cleanly, which for this service means stopping containers.
 *
 * A gateway that exits without doing this leaves running containers with
 * nothing tracking them — the orphans the lifecycle design exists to prevent.
 */
const shutdown = async (signal: string) => {
  logger.event('container_stopped', { reason: `shutting down on ${signal}` });
  await gateway.close().catch(() => undefined);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
