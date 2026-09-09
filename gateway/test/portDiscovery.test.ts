import { describe, expect, it, vi } from 'vitest';
import { PortWatcher, allowedOf, parseListeningPorts, proxyPathFor } from '../src/portDiscovery.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/observability.ts';
import { SyncIndex } from '../src/sync.ts';
import type { ContainerRecord } from '../src/lifecycle.ts';
import type { ContainerRuntime } from '../src/runtime/types.ts';

/**
 * Finding the development server, and not finding anything else.
 *
 * The parser gets most of the attention here because it is the part that fails
 * quietly: `/proc/net/tcp` is hex in two different senses, and a column
 * off-by-one produces a plausible-looking list of ports that is simply wrong.
 * A test with real kernel output is the only way to know it is right.
 */

/** Real `/proc/net/tcp`, from a container running a server on 5173. */
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 41234 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 41235 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:C1B4 01 00000000:00000000 00:00000000 00000000 10001        0 41236 1 0000000000000000 20 0 0 10 -1
`;

const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 41240 1 0000000000000000 100 0 0 10 0
`;

describe('reading the kernel’s list of listeners', () => {
  it('finds the ports that are actually in LISTEN', () => {
    // 0x1435 = 5173 (Vite), 0x1F90 = 8080.
    expect(parseListeningPorts(PROC_NET_TCP)).toEqual([5173, 8080]);
  });

  /**
   * The third row is an established connection to 8080, not a listener. It is
   * here because a parser that ignores the state column reports every peer a
   * process has ever connected to as a port it is serving.
   */
  it('ignores established connections', () => {
    const ports = parseListeningPorts(PROC_NET_TCP);

    expect(ports).toHaveLength(2);
  });

  it('reads IPv6 listeners, whose address column is four times as wide', () => {
    // 0x0BB8 = 3000.
    expect(parseListeningPorts(PROC_NET_TCP6)).toEqual([3000]);
  });

  it('reports a port once when it is bound on both stacks', () => {
    const both = parseListeningPorts(`${PROC_NET_TCP}${PROC_NET_TCP6}`);

    expect(both).toEqual([3000, 5173, 8080]);
  });

  it('is empty for an empty file, which is what --network none produces', () => {
    expect(parseListeningPorts('')).toEqual([]);
    expect(parseListeningPorts('  sl  local_address rem_address   st\n')).toEqual([]);
  });

  it('does not fall over on a truncated or garbled read', () => {
    expect(parseListeningPorts('nonsense\n\n   0: 0A\n')).toEqual([]);
  });
});

describe('the allowlist', () => {
  it('offers only ports the operator allows', () => {
    expect(allowedOf([22, 5173, 6379, 8080], [3000, 5173, 8080])).toEqual([5173, 8080]);
  });

  /**
   * The case this exists for: a workspace can listen on anything, and a
   * database or an SSH daemon inside it must not become a link somebody clicks.
   */
  it('does not offer a port merely because something is listening on it', () => {
    expect(allowedOf([22, 5432], [3000, 5173])).toEqual([]);
  });
});

describe('the URL a discovered port becomes', () => {
  it('is relative, so it resolves against whatever origin serves the gateway', () => {
    expect(proxyPathFor('tacode-abc123', 5173)).toBe('/proxy/tacode-abc123/5173/');
  });

  it('is addressed by container, which is what binds it to one workspace', () => {
    const url = proxyPathFor('tacode-abc123', 5173);

    // The proxy parses this back out and checks the caller owns that container.
    expect(url).toContain('tacode-abc123');
  });
});

function record(overrides: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 'tacode-abc123',
    userId: 'user-amina',
    projectId: 'proj-alpha',
    tier: loadConfig({}).tiers.free,
    status: 'ready',
    workspaceDir: '/tmp/nowhere',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    index: new SyncIndex(),
    openPorts: new Set(),
    ...overrides,
  };
}

function watcher(listening: () => Promise<number[]>) {
  const announced: Array<{ containerId: string; ports: number[] }> = [];
  const runtime = { listeningPorts: listening } as unknown as ContainerRuntime;
  const port = new PortWatcher({
    config: loadConfig({}),
    runtime,
    logger: createLogger(() => undefined),
    onPorts: (target, open) => announced.push({ containerId: target.id, ports: open }),
  });
  return { port, announced };
}

describe('watching a container for new servers', () => {
  it('announces a port when one appears', async () => {
    const { port, announced } = watcher(async () => [5173]);
    const container = record();

    await port.scan([container]);

    expect(announced).toEqual([{ containerId: container.id, ports: [5173] }]);
    expect([...container.openPorts]).toEqual([5173]);
  });

  it('says nothing on a sweep where nothing changed', async () => {
    const { port, announced } = watcher(async () => [5173]);
    const container = record();

    await port.scan([container]);
    await port.scan([container]);

    // One announcement, not one per poll: this runs every couple of seconds
    // for the life of the container.
    expect(announced).toHaveLength(1);
  });

  it('announces the remaining set when a server stops', async () => {
    let open = [5173, 8080];
    const { port, announced } = watcher(async () => open);
    const container = record();

    await port.scan([container]);
    open = [5173];
    await port.scan([container]);

    expect(announced.at(-1)).toEqual({ containerId: container.id, ports: [5173] });
  });

  /**
   * A `docker exec` can fail because the host is loaded, not because the
   * server stopped. Treating that as "no ports" makes a working preview link
   * vanish for one poll and return on the next.
   */
  it('leaves the list alone when the container cannot be asked', async () => {
    let fail = false;
    const { port, announced } = watcher(async () => {
      if (fail) throw new Error('exec failed');
      return [5173];
    });
    const container = record();

    await port.scan([container]);
    fail = true;
    await port.scan([container]);

    expect([...container.openPorts]).toEqual([5173]);
    expect(announced).toHaveLength(1);
  });

  it('does not ask a container that is not ready', async () => {
    const listening = vi.fn(async () => [5173]);
    const { port } = watcher(listening);

    await port.scan([record({ status: 'starting' })]);

    expect(listening).not.toHaveBeenCalled();
  });

  it('never announces a port outside the allowlist', async () => {
    const { port, announced } = watcher(async () => [22, 5432, 5173]);
    const container = record();

    await port.scan([container]);

    expect(announced[0].ports).toEqual([5173]);
    expect(container.openPorts.has(5432)).toBe(false);
  });

  /**
   * A slow sweep must not queue another behind it. Without the guard a loaded
   * host turns a poller into the load it was measuring.
   */
  it('does not start a sweep while one is running', async () => {
    let running = 0;
    let concurrent = 0;
    const { port } = watcher(async () => {
      running += 1;
      concurrent = Math.max(concurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return [5173];
    });
    const container = record();

    await Promise.all([port.scan([container]), port.scan([container]), port.scan([container])]);

    expect(concurrent).toBe(1);
  });
});
