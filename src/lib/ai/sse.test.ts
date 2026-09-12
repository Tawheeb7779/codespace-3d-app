// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readSse } from '@/lib/ai/sse';

/**
 * The wire format, tested against the ways a network actually delivers it.
 *
 * Every case here is a shape a real provider produces and a naive reader gets
 * wrong: a frame split across two packets, a multi-byte character split across
 * two packets, CRLF line endings, keep-alive comments, and a final frame with
 * no trailing blank line. Each of those silently loses part of a response, so
 * they are checked at the framing layer where they belong rather than through
 * a provider.
 */

/** A body that hands over exactly the byte runs given, in order. */
function bodyOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function frames(...chunks: Array<string | Uint8Array>) {
  const collected = [];
  for await (const frame of readSse(bodyOf(...chunks))) collected.push(frame);
  return collected;
}

describe('reading frames', () => {
  it('reads one frame per blank line', async () => {
    expect(await frames('data: one\n\ndata: two\n\n')).toEqual([
      { event: '', data: 'one' },
      { event: '', data: 'two' },
    ]);
  });

  /** The one that matters most: TCP splits wherever it likes. */
  it('joins a frame that arrived in pieces', async () => {
    expect(await frames('data: {"cho', 'ices":[1]}', '\n\n')).toEqual([
      { event: '', data: '{"choices":[1]}' },
    ]);
  });

  it('keeps a multi-byte character split across two reads intact', async () => {
    // The three bytes of "ع", delivered one and then two.
    const arabic = new TextEncoder().encode('data: ع\n\n');
    expect(await frames(arabic.slice(0, 7), arabic.slice(7))).toEqual([
      { event: '', data: 'ع' },
    ]);
  });

  it('reads the named event as well as the data', async () => {
    expect(await frames('event: content_block_delta\ndata: {"a":1}\n\n')).toEqual([
      { event: 'content_block_delta', data: '{"a":1}' },
    ]);
  });

  it('handles CRLF, including a split between the two', async () => {
    expect(await frames('data: one\r', '\n\r\n')).toEqual([{ event: '', data: 'one' }]);
  });

  it('joins multiple data lines with a newline, as the spec says', async () => {
    expect(await frames('data: first\ndata: second\n\n')).toEqual([
      { event: '', data: 'first\nsecond' },
    ]);
  });

  /** Traffic that exists to hold the connection open is not content. */
  it('skips comment lines without emitting a frame', async () => {
    expect(await frames(': keep-alive\n\ndata: real\n\n')).toEqual([
      { event: '', data: 'real' },
    ]);
  });

  it('emits a final frame that arrived without a trailing blank line', async () => {
    expect(await frames('data: [DONE]')).toEqual([{ event: '', data: '[DONE]' }]);
  });

  it('tolerates a data field with no space after the colon', async () => {
    expect(await frames('data:tight\n\n')).toEqual([{ event: '', data: 'tight' }]);
  });

  it('preserves the value of an empty data line', async () => {
    expect(await frames('data:\n\n')).toEqual([{ event: '', data: '' }]);
  });
});

describe('releasing the body', () => {
  /**
   * A consumer that stops early must not leave the connection open, or a
   * cancelled generation keeps being produced — and paid for — with nobody
   * reading it.
   */
  it('cancels the body when the consumer stops reading', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const frame of readSse(body)) {
      expect(frame.data).toBe('one');
      break;
    }

    expect(cancelled).toBe(true);
  });

  it('cancels the body when the consumer throws', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      (async () => {
        for await (const _frame of readSse(body)) throw new Error('interpretation failed');
      })(),
    ).rejects.toThrow('interpretation failed');
    expect(cancelled).toBe(true);
  });
});
