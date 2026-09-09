import type { ContainerRecord } from './lifecycle.ts';
import type { GatewayConfig } from './config.ts';
import type { Logger } from './observability.ts';
import type { ContainerRuntime } from './runtime/types.ts';

/**
 * Noticing that a development server started.
 *
 * Asked of the kernel, not of the user's output. Watching the terminal for
 * "Local: http://localhost:5173" is the obvious approach and it is wrong in
 * every direction: every framework prints something different, the text can be
 * arbitrarily delayed or coloured, a server that prints nothing is invisible,
 * and — the part that matters — a process can print whatever it likes, so a
 * discovered port would be a claim by the workload rather than a fact about it.
 *
 * `/proc/net/tcp` is per network namespace, so reading it inside the container
 * lists that container's listeners and nothing else. A container with
 * `--network none` has no listeners to find, which is the correct answer rather
 * than a missing feature.
 *
 * Discovery does not grant access. The proxy authorises every request on its
 * own — the caller's token, their membership of the project, their ownership of
 * the container, and the port allowlist — and none of that consults this. What
 * this produces is the list the UI offers, so a port appearing here is an
 * invitation to click, never a capability.
 */

/** `/proc/net/tcp`'s code for a socket in LISTEN. */
const TCP_LISTEN = '0A';

/**
 * Listening ports from the contents of `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * Pure, because the parsing is the part that can be wrong in a way nobody
 * notices: the local address is hex and big-endian-per-field, the state column
 * is hex too, and an off-by-one in the columns silently yields ports that are
 * either always empty or always wrong.
 */
export function parseListeningPorts(proc: string): number[] {
  const ports = new Set<number>();

  for (const line of proc.split('\n')) {
    const columns = line.trim().split(/\s+/);
    // sl, local_address, rem_address, st, …
    if (columns.length < 4) continue;
    if (columns[3] !== TCP_LISTEN) continue;

    const local = columns[1];
    const colon = local.lastIndexOf(':');
    if (colon === -1) continue;
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }

  return [...ports].sort((a, b) => a - b);
}

/** Ports the operator allows a preview for, in the order a person would try. */
export function allowedOf(ports: number[], allowlist: readonly number[]): number[] {
  return ports.filter((port) => allowlist.includes(port));
}

/**
 * The path a browser uses to reach one of these ports.
 *
 * Relative on purpose. The gateway does not know its own public URL — it may be
 * behind any number of proxies — and inventing one produces a link that works
 * in development and breaks in production. The browser resolves this against
 * the gateway origin it is already talking to, which is correct by
 * construction.
 */
export function proxyPathFor(containerId: string, port: number): string {
  return `/proxy/${containerId}/${port}/`;
}

export interface PortWatcherDeps {
  config: GatewayConfig;
  runtime: ContainerRuntime;
  logger: Logger;
  /** Called with the full current set whenever it changes. */
  onPorts: (record: ContainerRecord, ports: number[]) => void;
}

/**
 * Polls each container for its listeners and reports the changes.
 *
 * Polling rather than an event: there is no notification when a process calls
 * `listen`, short of tracing syscalls, and a poll of a file the kernel
 * generates is cheap enough to do every couple of seconds for every live
 * container.
 */
export class PortWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(private readonly deps: PortWatcherDeps) {}

  start(records: () => ContainerRecord[], intervalMs = 2500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan(records()).catch(() => undefined);
    }, intervalMs);
    // Cleanup work must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep.
   *
   * Guarded against overlap: a slow `docker exec` on a loaded host must not
   * queue a second sweep behind the first, which is how a poller becomes the
   * load it was measuring.
   */
  async scan(records: ContainerRecord[]): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const record of records) {
        if (record.status !== 'ready') continue;

        const listening = await this.deps.runtime.listeningPorts(record.id).catch(() => null);
        // A container that cannot be asked is left exactly as it was. Clearing
        // the list on a transient failure would make a working preview link
        // disappear from the UI for one poll and come back on the next.
        if (listening === null) continue;

        const allowed = allowedOf(listening, this.deps.config.allowedPorts);
        const opened = allowed.filter((port) => !record.openPorts.has(port));
        const closed = [...record.openPorts].filter((port) => !allowed.includes(port));
        if (!opened.length && !closed.length) continue;

        for (const port of opened) {
          record.openPorts.add(port);
          this.deps.logger.event('port_opened', { containerId: record.id, userId: record.userId, port });
        }
        for (const port of closed) {
          record.openPorts.delete(port);
          this.deps.logger.event('port_closed', { containerId: record.id, userId: record.userId, port });
        }

        this.deps.onPorts(record, [...record.openPorts].sort((a, b) => a - b));
      }
    } finally {
      this.scanning = false;
    }
  }
}
