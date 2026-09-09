// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContainerTerminal,
  base64ToBytes,
  bytesToBase64,
} from '@/lib/terminal/containerClient';
import { LIMITS, PROTOCOL_VERSION } from '@/lib/terminal/protocol';

/**
 * The browser's half of the container terminal.
 *
 * What matters here is what happens when the connection is not fine: a session
 * that outlives its socket, a reconnect that must ask for the right gap, and a
 * refusal that must not be retried forever. The gateway's half is tested where
 * it runs, against real PTYs, in `gateway/test`.
 */

/** A WebSocket that a test drives, standing in for a gateway. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** The frames this socket was given, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

const ready = (sessionId = 'sess-1', resumed = false) => ({
  type: 'ready',
  protocol: PROTOCOL_VERSION,
  sessionId,
  containerId: 'tacode-abc',
  status: 'ready',
  runtime: 'docker',
  resumed,
  seq: 0,
});

let output: Uint8Array[];
let states: string[];

/** The last element, spelled out: this project's lib target predates `at`. */
const last = <T>(items: T[]): T | undefined => items[items.length - 1];

function build(overrides: Partial<ConstructorParameters<typeof ContainerTerminal>[0]> = {}) {
  output = [];
  states = [];
  return new ContainerTerminal({
    gatewayUrl: 'wss://gw.test',
    projectId: 'proj-1',
    token: async () => 'session-token',
    cols: 80,
    rows: 24,
    onOutput: (bytes) => output.push(bytes),
    onState: (state) => states.push(state),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  });
}

const socket = (index = 0) => FakeSocket.instances[index];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a terminal', () => {
  it('sends a hello with the session token and the project', async () => {
    const client = build();
    await client.connect();
    socket().open();

    const [hello] = socket().frames();
    expect(hello).toMatchObject({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'session-token',
      projectId: 'proj-1',
      cols: 80,
    });
  });

  it('goes to the gateway’s terminal endpoint', async () => {
    const client = build();
    await client.connect();

    expect(socket().url).toBe('wss://gw.test/terminal');
  });

  /**
   * Without a session there is nobody to be, so this is not a transient
   * failure to retry — it is a state to report.
   */
  it('does not connect at all when the user is signed out', async () => {
    const client = build({ token: async () => null });
    await client.connect();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(last(states)).toBe('unavailable');
  });

  it('reports ready once the gateway answers', async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver(ready());

    expect(last(states)).toBe('ready');
    expect(client.sessionId).toBe('sess-1');
    expect(client.runtime).toBe('docker');
  });
});

describe('typing and output', () => {
  const connected = async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver(ready());
    return client;
  };

  it('sends keystrokes as base64, because terminal bytes are not text', async () => {
    const client = await connected();

    client.write('ls\n');

    const input = last(socket().frames())!;
    expect(input.type).toBe('input');
    expect(Buffer.from(String(input.data), 'base64').toString()).toBe('ls\n');
  });

  /**
   * A paste arrives from xterm as one call and can be far larger than a frame
   * is allowed to be. Chunking here rather than at the gateway means the frame
   * limit is never breached in the first place.
   */
  it('splits a paste too large for one frame', async () => {
    const client = await connected();
    const before = socket().sent.length;

    client.write('x'.repeat(LIMITS.maxInputBytes * 2 + 10));

    const frames = socket().frames().slice(before);
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) {
      expect(String(frame.data).length).toBeLessThanOrEqual(
        Math.ceil((LIMITS.maxInputBytes * 4) / 3) + 8,
      );
    }
  });

  it('decodes output and tracks the sequence it has seen', async () => {
    const client = await connected();

    socket().deliver({ type: 'output', sessionId: 'sess-1', seq: 7, data: bytesToBase64(new TextEncoder().encode('hi')) });

    expect(new TextDecoder().decode(output[0])).toBe('hi');
    // Not asserted directly — it is private — but the reconnect below proves it.
    expect(client.sessionId).toBe('sess-1');
  });

  it('ignores a frame the gateway should not have sent', async () => {
    await connected();

    socket().onmessage?.({ data: '{ not json' });
    socket().onmessage?.({ data: JSON.stringify({ type: 'output', sessionId: '../x', seq: 1, data: 'aGk=' }) });

    expect(output).toHaveLength(0);
  });
});

describe('losing the connection', () => {
  it('reconnects, asking to resume the same session from where it left off', async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver(ready());
    socket().deliver({ type: 'output', sessionId: 'sess-1', seq: 12, data: 'aGk=' });

    socket().close();
    expect(states).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(1000);
    socket(1).open();

    const [hello] = socket(1).frames();
    expect(hello).toMatchObject({ type: 'hello', sessionId: 'sess-1', lastSeq: 12 });
  });

  it('backs off, so a gateway coming back is not stampeded', async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().close();

    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  /**
   * Retrying an authentication or protocol failure just repeats it, and a
   * client that hammers a gateway it will never be admitted to is a
   * denial-of-service on its own users.
   */
  it('stops retrying after a fatal refusal', async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver({
      type: 'error',
      code: 'PERMISSION_ERROR',
      message: 'You need edit access to this project to open a terminal.',
      fatal: true,
    });

    socket().close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(last(states)).toBe('unavailable');
  });

  it('starts a fresh shell after the old one exited, rather than resuming a corpse', async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver(ready());
    socket().deliver({ type: 'exit', sessionId: 'sess-1', exitCode: 0, signal: null });

    socket().close();
    await vi.advanceTimersByTimeAsync(2000);
    socket(1).open();

    const [hello] = socket(1).frames();
    expect(hello.sessionId).toBeUndefined();
  });
});

describe('closing the panel', () => {
  const connected = async () => {
    const client = build();
    await client.connect();
    socket().open();
    socket().deliver(ready());
    return client;
  };

  /**
   * The behaviour the whole feature rests on: closing a panel is not stopping
   * a server.
   */
  it('detaches without killing by default', async () => {
    const client = await connected();

    client.disconnect();

    expect(last(socket().frames())).toMatchObject({ type: 'detach', kill: false });
    // The session is remembered, so reopening reattaches to it.
    expect(client.sessionId).toBe('sess-1');
  });

  it('kills when explicitly asked, and forgets the session', async () => {
    const client = await connected();

    client.disconnect(true);

    expect(last(socket().frames())).toMatchObject({ type: 'detach', kill: true });
    expect(client.sessionId).toBeNull();
  });

  it('does not reconnect after a deliberate disconnect', async () => {
    const client = await connected();

    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('base64 for bytes that are not text', () => {
  it('round-trips every byte value, which UTF-8 would not', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;

    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
  });

  it('round-trips an escape sequence unchanged', () => {
    const escape = new TextEncoder().encode('\x1b[31mred\x1b[0m');

    expect(new TextDecoder().decode(base64ToBytes(bytesToBase64(escape)))).toBe('\x1b[31mred\x1b[0m');
  });
});
