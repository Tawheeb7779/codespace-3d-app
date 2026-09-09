import { LIMITS } from '../../src/lib/terminal/protocol.ts';
import type { PtyHandle } from './runtime/types.ts';

/**
 * One terminal session: a PTY, and everything needed to survive losing its
 * socket.
 *
 * The distinction the whole feature rests on is that a session is not a
 * connection. Closing a laptop lid must not kill `npm run dev`; a reconnect
 * five minutes later should land back in the same shell with the output that
 * was produced in between. So the PTY belongs to the session, the socket comes
 * and goes, and the gap between them is covered by a bounded replay buffer.
 *
 * Backpressure runs the other way. A process that prints faster than a browser
 * can render — `yes`, a build with a stuck progress bar, a log tail — must not
 * be able to grow this process's memory without limit. There is no way to pause
 * a PTY, so output always lands in a fixed-size ring and the ring drops its
 * oldest bytes when a slow client falls behind. That is the same thing terminal
 * scrollback does, and it is bounded by construction rather than by hoping the
 * client keeps up.
 */

export interface OutputChunk {
  seq: number;
  data: string;
}

export type SessionState = 'running' | 'exited';

export interface SessionExit {
  exitCode: number | null;
  signal: string | null;
}

/** How much a socket may have queued before we stop handing it more. */
const SOCKET_HIGH_WATER = 512 * 1024;

export interface SessionOptions {
  id: string;
  containerId: string;
  userId: string;
  pty: PtyHandle;
  /** Bytes of output kept for replay. Defaults to the protocol's suggestion. */
  replayBytes?: number;
}

export class TerminalSession {
  readonly id: string;
  readonly containerId: string;
  readonly userId: string;
  readonly startedAt = Date.now();

  private readonly pty: PtyHandle;
  private readonly replayBytes: number;
  private readonly buffer: OutputChunk[] = [];
  private bufferedBytes = 0;
  private nextSeq = 1;

  private sink: ((chunk: OutputChunk) => void) | null = null;
  private pending: (() => number) | null = null;
  private queue: OutputChunk[] = [];

  private exitListener: ((exit: SessionExit) => void) | null = null;

  state: SessionState = 'running';
  exit: SessionExit | null = null;
  lastActivity = Date.now();
  /** Set while no socket is attached, for the idle reaper to read. */
  detachedSince: number | null = Date.now();

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.containerId = options.containerId;
    this.userId = options.userId;
    this.pty = options.pty;
    this.replayBytes = options.replayBytes ?? LIMITS.replayBufferBytes;

    this.pty.onData((chunk) => this.onOutput(chunk));
    this.pty.onExit((result) => {
      this.state = 'exited';
      this.exit = result;
      this.exitListener?.(result);
    });
  }

  get seq(): number {
    return this.nextSeq - 1;
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  /**
   * Split output into protocol-sized chunks and hand them on.
   *
   * A PTY can deliver a great deal at once — a `cat` of a large file arrives in
   * a handful of reads — and one frame per read would breach the frame cap.
   */
  private onOutput(chunk: string): void {
    this.lastActivity = Date.now();
    const bytes = Buffer.from(chunk, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += LIMITS.maxOutputBytes) {
      const slice = bytes.subarray(offset, offset + LIMITS.maxOutputBytes);
      const frame: OutputChunk = { seq: this.nextSeq++, data: slice.toString('base64') };
      this.remember(frame);
      this.deliver(frame);
    }
  }

  private remember(frame: OutputChunk): void {
    this.buffer.push(frame);
    this.bufferedBytes += frame.data.length;
    while (this.bufferedBytes > this.replayBytes && this.buffer.length > 1) {
      const dropped = this.buffer.shift();
      if (dropped) this.bufferedBytes -= dropped.data.length;
    }
  }

  /**
   * Send now, or hold until the socket drains.
   *
   * The queue is bounded by the same ring as replay: if a client is so far
   * behind that the queue exceeds it, the oldest queued output is dropped. The
   * client discovers this from the sequence gap and can redraw; nothing here
   * grows without limit.
   */
  private deliver(frame: OutputChunk): void {
    if (!this.sink) return;
    const buffered = this.pending?.() ?? 0;
    if (buffered > SOCKET_HIGH_WATER || this.queue.length > 0) {
      this.queue.push(frame);
      let queuedBytes = this.queue.reduce((total, entry) => total + entry.data.length, 0);
      while (queuedBytes > this.replayBytes && this.queue.length > 1) {
        const dropped = this.queue.shift();
        queuedBytes -= dropped?.data.length ?? 0;
      }
      return;
    }
    this.sink(frame);
  }

  /** Called when the socket has drained, to release anything held back. */
  flush(): void {
    if (!this.sink) return;
    while (this.queue.length) {
      const buffered = this.pending?.() ?? 0;
      if (buffered > SOCKET_HIGH_WATER) return;
      const frame = this.queue.shift();
      if (frame) this.sink(frame);
    }
  }

  /**
   * Attach a socket, replaying what it missed.
   *
   * `lastSeq` is what the client last rendered. Everything after it that is
   * still in the ring is replayed; anything older was dropped while it was away
   * and the sequence gap says so.
   */
  attach(
    sink: (chunk: OutputChunk) => void,
    bufferedAmount: () => number,
    lastSeq = 0,
  ): { replayed: number; gap: boolean } {
    this.sink = sink;
    this.pending = bufferedAmount;
    this.queue = [];
    this.detachedSince = null;
    this.lastActivity = Date.now();

    const missed = this.buffer.filter((frame) => frame.seq > lastSeq);
    const oldest = this.buffer[0]?.seq ?? this.nextSeq;
    const gap = lastSeq > 0 && oldest > lastSeq + 1;
    for (const frame of missed) sink(frame);
    return { replayed: missed.length, gap };
  }

  detach(): void {
    this.sink = null;
    this.pending = null;
    this.queue = [];
    this.detachedSince = Date.now();
  }

  write(data: string): void {
    if (this.state !== 'running') return;
    this.lastActivity = Date.now();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.state !== 'running') return;
    this.pty.resize(cols, rows);
  }

  /**
   * Deliver a signal.
   *
   * Only the ones a keyboard can already produce. A terminal that can send an
   * arbitrary signal to an arbitrary target is a different feature with
   * different consequences, and nothing in the product needs it.
   */
  signal(name: 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGHUP'): void {
    if (this.state !== 'running') return;
    this.lastActivity = Date.now();
    this.pty.kill(name);
  }

  onExit(listener: (exit: SessionExit) => void): void {
    this.exitListener = listener;
    if (this.state === 'exited' && this.exit) listener(this.exit);
  }

  kill(): void {
    if (this.state === 'running') this.pty.kill('SIGKILL');
    this.detach();
  }
}

/**
 * Every live session, indexed so that attaching to one is an authorisation
 * decision rather than a lookup.
 *
 * `find` takes the caller's user id and returns nothing for a session that is
 * not theirs — the id alone is never enough. Session ids are unguessable, but
 * "unguessable" is not an access control, and this is the check that stops one
 * user attaching to another's shell by replaying an id they saw.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>();

  add(session: TerminalSession): void {
    this.sessions.set(session.id, session);
  }

  find(id: string, userId: string): TerminalSession | null {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return null;
    return session;
  }

  forContainer(containerId: string): TerminalSession[] {
    return [...this.sessions.values()].filter((session) => session.containerId === containerId);
  }

  /**
   * Live sessions on a container.
   *
   * Exited ones do not count. A shell the user typed `exit` into still exists
   * as a record until it is reaped, and counting it would mean somebody who
   * closed three terminals cannot open a fourth — the limit is meant to bound
   * concurrent shells, not to remember old ones.
   */
  countFor(containerId: string): number {
    return this.forContainer(containerId).filter((session) => session.state === 'running').length;
  }

  /**
   * Drop sessions nobody will come back to.
   *
   * Two kinds. A shell that has exited has nothing left to attach to. A shell
   * that is both detached *and* quiet is one whose tab was closed and not
   * reopened.
   *
   * Both halves are required, and the first version of this had only the
   * detachment half — which would have killed exactly the thing the feature
   * exists to protect. `npm run dev` with the browser closed is detached for
   * hours and busy the whole time; it is idleness that makes a session
   * abandoned, not the absence of a socket. Caught by a test that asserted a
   * working process survives its idle window.
   */
  prune(graceSeconds: number, now = Date.now()): string[] {
    const dropped: string[] = [];
    for (const session of this.all) {
      const quietFor = (now - session.lastActivity) / 1000;
      const abandoned = !session.attached && quietFor > graceSeconds;
      if (session.state === 'exited' || abandoned) {
        this.remove(session.id);
        dropped.push(session.id);
      }
    }
    return dropped;
  }

  remove(id: string): void {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }

  removeForContainer(containerId: string): void {
    for (const session of this.forContainer(containerId)) this.remove(session.id);
  }

  get all(): TerminalSession[] {
    return [...this.sessions.values()];
  }
}
