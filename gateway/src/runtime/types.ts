import type { ResourceTier } from '../config.ts';

/**
 * What the rest of the gateway is allowed to know about a container.
 *
 * Everything above this interface — authentication, the protocol, sync, the
 * port proxy — is runtime-agnostic, which is what lets the whole stack be
 * tested on a machine that cannot run containers while the deployed thing runs
 * Docker. It is also what keeps a future move to another isolation technology
 * from being a rewrite.
 */

export interface CreateOptions {
  containerId: string;
  /** Host directory holding the project's files. Bind-mounted as the workspace. */
  workspaceDir: string;
  tier: ResourceTier;
  image: string;
  network: 'none' | 'full';
}

export interface SpawnOptions {
  /** Absolute path inside the container. */
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/** A running PTY, however the runtime provides one. */
export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (result: { exitCode: number | null; signal: string | null }) => void): void;
  readonly pid: number;
}

export interface ContainerRuntime {
  /** Named in logs and shown in the UI, so nobody has to guess what they are on. */
  readonly name: string;
  /**
   * Whether this runtime isolates the workload from the host.
   *
   * Read by the server at boot to refuse to run a non-isolating runtime in
   * production. It exists so that "this one is only for development" is a fact
   * the code can act on rather than a line in a README.
   */
  readonly isolates: boolean;

  available(): Promise<boolean>;
  create(options: CreateOptions): Promise<void>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  destroy(containerId: string): Promise<void>;
  /** Whether the runtime still has it. The database's opinion does not count. */
  exists(containerId: string): Promise<boolean>;
  spawnShell(containerId: string, options: SpawnOptions): Promise<PtyHandle>;
  /**
   * Where a proxied connection to a container port should go.
   *
   * Returned as a host/port pair rather than the proxy reaching into container
   * internals, so the port proxy never learns anything runtime-specific.
   */
  endpointFor(containerId: string, port: number): Promise<{ host: string; port: number } | null>;
}
