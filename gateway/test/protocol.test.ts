import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
} from '../../src/lib/terminal/protocol.ts';

/**
 * The frame parser is the outer wall.
 *
 * Everything the gateway does with a WebSocket goes through it, before any
 * authentication has happened — the socket is anonymous until the `hello` frame
 * inside it has been parsed and checked. So this suite is mostly about what the
 * parser refuses, and about the fact that it refuses rather than coerces: a
 * lenient parser here would mean the rest of the gateway receiving fields whose
 * shape nobody verified.
 */

const hello = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: 'jwt', projectId: 'p1', ...extra });

describe('frames it accepts', () => {
  it('reads a hello with the fields the gateway needs', () => {
    const frame = parseClientFrame(hello({ cols: 120, rows: 40 }));

    expect(frame).toMatchObject({ type: 'hello', projectId: 'p1', cols: 120, rows: 40 });
  });

  it('reads input, resize, signal, detach and ping', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'input', sessionId: 's1', data: 'bHM=' }))).toMatchObject({
      type: 'input',
      data: 'bHM=',
    });
    expect(
      parseClientFrame(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 80, rows: 24 })),
    ).toMatchObject({ cols: 80, rows: 24 });
    expect(
      parseClientFrame(JSON.stringify({ type: 'signal', sessionId: 's1', signal: 'SIGINT' })),
    ).toMatchObject({ signal: 'SIGINT' });
    expect(parseClientFrame(JSON.stringify({ type: 'detach', sessionId: 's1' }))).toMatchObject({
      kill: false,
    });
    expect(parseClientFrame(JSON.stringify({ type: 'ping', at: 5 }))).toMatchObject({ at: 5 });
  });

  /**
   * The default that keeps a development server alive when a tab closes. If
   * this ever flips, `npm run dev` dies with the lid of a laptop.
   */
  it('does not kill the shell on detach unless asked', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'detach', sessionId: 's1' }))).toMatchObject({
      kill: false,
    });
    expect(
      parseClientFrame(JSON.stringify({ type: 'detach', sessionId: 's1', kill: 'yes' })),
    ).toMatchObject({ kill: false });
    expect(
      parseClientFrame(JSON.stringify({ type: 'detach', sessionId: 's1', kill: true })),
    ).toMatchObject({ kill: true });
  });
});

describe('frames it refuses', () => {
  const refused = (raw: string) => expect(() => parseClientFrame(raw)).toThrow(ProtocolError);

  it('refuses anything that is not an object of a known type', () => {
    refused('not json');
    refused('[]');
    refused('"a string"');
    refused('null');
    refused(JSON.stringify({ type: 'exec', command: 'rm -rf /' }));
    refused(JSON.stringify({ nope: true }));
  });

  it('refuses a frame larger than the cap, without parsing it', () => {
    refused(JSON.stringify({ type: 'input', sessionId: 's1', data: 'A'.repeat(LIMITS.maxFrameBytes) }));
  });

  it('refuses input that is not base64, so raw bytes cannot be smuggled', () => {
    refused(JSON.stringify({ type: 'input', sessionId: 's1', data: 'ls -la\n' }));
    refused(JSON.stringify({ type: 'input', sessionId: 's1', data: '../../etc' }));
  });

  /**
   * Ids reach a filesystem path, a container name and a database filter before
   * anybody looks at them again, so the character set is closed rather than
   * merely non-empty.
   */
  it('refuses an identifier that could be a path or a filter', () => {
    for (const sessionId of ['../escape', 'a/b', 'id;rm -rf /', 'id eq.other', 'a'.repeat(200), '']) {
      refused(JSON.stringify({ type: 'input', sessionId, data: 'aGk=' }));
    }
  });

  it('refuses geometry outside what a terminal can be', () => {
    refused(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 0, rows: 24 }));
    refused(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 99999, rows: 24 }));
    refused(JSON.stringify({ type: 'resize', sessionId: 's1', cols: 80, rows: -1 }));
    refused(JSON.stringify({ type: 'resize', sessionId: 's1', cols: '80', rows: 24 }));
  });

  it('refuses a signal a keyboard could not send', () => {
    refused(JSON.stringify({ type: 'signal', sessionId: 's1', signal: 'SIGKILL' }));
    refused(JSON.stringify({ type: 'signal', sessionId: 's1', signal: 'SIGSTOP' }));
  });

  it('refuses a token long enough to be a payload', () => {
    refused(hello({ token: 'x'.repeat(9000) }));
  });
});

describe('the server frames the browser accepts', () => {
  it('reads the frames the gateway actually sends', () => {
    expect(
      parseServerFrame(
        JSON.stringify({
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          sessionId: 's1',
          containerId: 'c1',
          status: 'ready',
          runtime: 'docker',
          resumed: true,
          seq: 12,
        }),
      ),
    ).toMatchObject({ type: 'ready', resumed: true, seq: 12 });

    expect(
      parseServerFrame(JSON.stringify({ type: 'output', sessionId: 's1', seq: 3, data: 'aGk=' })),
    ).toMatchObject({ seq: 3 });

    expect(
      parseServerFrame(JSON.stringify({ type: 'exit', sessionId: 's1', exitCode: 0, signal: null })),
    ).toMatchObject({ exitCode: 0 });
  });

  /**
   * The browser validates the gateway too. A gateway is more trusted than a
   * browser but not trusted: these frames drive an editor.
   */
  it('refuses a malformed frame from the gateway rather than half-applying it', () => {
    expect(() => parseServerFrame(JSON.stringify({ type: 'status', containerId: '../x', status: 'ready' }))).toThrow(
      ProtocolError,
    );
    expect(() => parseServerFrame(JSON.stringify({ type: 'output', sessionId: 's1', seq: 1 }))).toThrow(
      ProtocolError,
    );
    expect(() => parseServerFrame(JSON.stringify({ type: 'ready', protocol: 1 }))).toThrow(ProtocolError);
  });

  it('degrades an unknown error code rather than trusting it', () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: 'error', code: 'MADE_UP', message: 'x', fatal: false }),
    );

    expect(frame).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('encoding', () => {
  it('refuses to send a frame that would breach the cap', () => {
    expect(() =>
      encodeFrame({ type: 'output', sessionId: 's1', seq: 1, data: 'A'.repeat(LIMITS.maxFrameBytes) }),
    ).toThrow(ProtocolError);
  });

  it('round-trips every frame it encodes', () => {
    const raw = encodeFrame({ type: 'output', sessionId: 's1', seq: 9, data: 'aGVsbG8=' });

    expect(parseServerFrame(raw)).toEqual({ type: 'output', sessionId: 's1', seq: 9, data: 'aGVsbG8=' });
  });
});
