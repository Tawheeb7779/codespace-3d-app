// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  REQUEST_TIMEOUT_MS,
  complete,
  forgetStreamingRefusals,
  type ProviderConfig,
  type StreamHandler,
} from '@/lib/ai/provider';
import { toolsFor } from '@/lib/ai/tools';

/**
 * Streaming, against the provider protocols as they are actually spoken.
 *
 * Nothing here is a simulation of streaming: every case drives the real
 * transport over a body delivered in pieces, and what is asserted is that the
 * text reaches the caller while the response is still arriving. The two
 * properties worth more than the happy path are that a partial answer is never
 * presented as a whole one, and that stopping actually stops the request —
 * rendering nothing while the provider keeps generating is the expensive kind
 * of wrong.
 */

const OPENAI: ProviderConfig = { kind: 'openai', model: 'm', baseUrl: 'http://provider.test/v1' };
const ANTHROPIC: ProviderConfig = { kind: 'anthropic', model: 'm', baseUrl: '' };

/** The real tool definitions, so the request under test is the real request. */
const TOOLS = toolsFor(true);

/** An OpenAI-compatible chunk, and the sentinel that ends the stream. */
const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

/** An Anthropic event, which names itself in the `event:` field. */
const event = (name: string, payload: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

type Reply =
  /** Byte runs of an event stream, optionally left open at the end. */
  | { sse: string[]; hold?: boolean }
  /** A whole JSON body, as a provider that ignored `stream: true` answers. */
  | { json: unknown }
  | { status: number; text: string };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/**
 * A stubbed fetch that behaves like a real one in the way that matters: its
 * body is a live stream, and aborting the request errors that stream rather
 * than quietly leaving it readable.
 */
function stubFetch(replies: Reply[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body ?? '{}')) });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;

    if ('json' in reply) {
      return new Response(JSON.stringify(reply.json), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('status' in reply) {
      return new Response(reply.text, {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    const signal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const part of reply.sse) controller.enqueue(encoder.encode(part));
        if (reply.hold) {
          signal.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', impl);
  return { impl, calls };
}

/** A fetch that never answers until the request is aborted. */
function hangingFetch() {
  const impl = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

function collector(): StreamHandler & { seen: string[] } {
  const seen: string[] = [];
  return { seen, onText: (text) => seen.push(text) };
}

const run = (
  config: ProviderConfig,
  stream: StreamHandler | null,
  signal = new AbortController().signal,
) => complete(config, 'key', 'system', [{ role: 'user', content: 'hi' }], TOOLS, signal, null, stream);

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected the streamed call to fail, but it resolved');
}

beforeEach(() => {
  forgetStreamingRefusals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('asking for a stream', () => {
  it('sends the provider its own streaming flag, and only when streaming', async () => {
    const { calls } = stubFetch([{ sse: [chunk({ content: 'hi' }), DONE] }]);

    await run(OPENAI, collector());
    expect(calls[0].body.stream).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('makes the same whole-response call as before when no handler is given', async () => {
    const { calls } = stubFetch([{ json: { choices: [{ message: { content: 'hi' } }] } }]);

    await expect(run(OPENAI, null)).resolves.toMatchObject({ text: 'hi' });
    expect(calls[0].body.stream).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).accept).toBeUndefined();
  });

  /** A model the provider said cannot stream is not asked to. */
  it('does not ask a model the provider said cannot stream', async () => {
    const { calls } = stubFetch([{ json: { choices: [{ message: { content: 'hi' } }] } }]);

    await expect(run({ ...OPENAI, streaming: false }, collector())).resolves.toMatchObject({
      text: 'hi',
    });
    expect(calls[0].body.stream).toBeUndefined();
  });

  /** Silence is not a denial, so a stream is still attempted. */
  it('still streams from a model whose support was never stated', async () => {
    const { calls } = stubFetch([{ sse: [chunk({ content: 'hi' }), DONE] }]);

    await run({ ...OPENAI, streaming: null }, collector());
    expect(calls[0].body.stream).toBe(true);
  });

  it('sends the key in a header, never in the URL of a streamed request', async () => {
    const { calls } = stubFetch([{ sse: [chunk({ content: 'hi' }), DONE] }]);

    await run({ ...OPENAI, baseUrl: 'http://provider.test/v1' }, collector());

    expect(calls[0].url).not.toContain('key');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer key');
  });
});

describe('an OpenAI-compatible stream', () => {
  it('hands over the text as it arrives, cumulatively', async () => {
    const stream = collector();
    stubFetch([{ sse: [chunk({ content: 'Hel' }), chunk({ content: 'lo' }), DONE] }]);

    const result = await run(OPENAI, stream);

    expect(stream.seen).toEqual(['Hel', 'Hello']);
    expect(result.text).toBe('Hello');
  });

  it('reads a chunk that arrived in two pieces as one chunk', async () => {
    const stream = collector();
    const whole = chunk({ content: 'split' });
    stubFetch([{ sse: [whole.slice(0, 18), whole.slice(18), DONE] }]);

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'split' });
    expect(stream.seen).toEqual(['split']);
  });

  /** Empty deltas are frequent, and are neither content nor an error. */
  it('reports nothing for an empty delta', async () => {
    const stream = collector();
    stubFetch([
      { sse: [chunk({ role: 'assistant' }), chunk({ content: '' }), chunk({ content: 'a' }), DONE] },
    ]);

    await run(OPENAI, stream);

    expect(stream.seen).toEqual(['a']);
  });

  it('assembles a tool call from the pieces it arrives in', async () => {
    stubFetch([
      {
        sse: [
          chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
          chunk({}, { finish_reason: 'tool_calls' }),
          DONE,
        ],
      },
    ]);

    const result = await run(OPENAI, collector());

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
    expect(result.stopReason).toBe('tool_calls');
  });

  it('keeps two tool calls apart, in the order the provider indexed them', async () => {
    stubFetch([
      {
        sse: [
          chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] }),
          chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] }),
          chunk({}, { finish_reason: 'tool_calls' }),
          DONE,
        ],
      },
    ]);

    const result = await run(OPENAI, collector());

    expect(result.toolCalls.map((call) => call.name)).toEqual(['first', 'second']);
  });

  /**
   * The rebuilt message goes back to the provider as transcript on the next
   * step, so it has to be the provider's own shape — not this app's.
   */
  it('rebuilds the assistant message the next step has to send back', async () => {
    stubFetch([
      {
        sse: [
          chunk({ content: 'looking' }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] }),
          chunk({}, { finish_reason: 'tool_calls' }),
          DONE,
        ],
      },
    ]);

    const result = await run(OPENAI, collector());

    expect(result.raw).toEqual({
      role: 'assistant',
      content: 'looking',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
  });

  it('finishes on a finish_reason even without the sentinel', async () => {
    stubFetch([{ sse: [chunk({ content: 'done' }), chunk({}, { finish_reason: 'stop' })] }]);

    await expect(run(OPENAI, collector())).resolves.toMatchObject({
      text: 'done',
      stopReason: 'stop',
    });
  });

  /** Usage generally arrives in a chunk after the finish reason. */
  it('keeps reading after the finish reason, for the usage chunk', async () => {
    stubFetch([
      {
        sse: [
          chunk({ content: 'x' }),
          chunk({}, { finish_reason: 'stop' }),
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`,
          DONE,
        ],
      },
    ]);

    const result = await run(OPENAI, collector());

    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it('leaves usage unknown when the provider never reported it', async () => {
    stubFetch([{ sse: [chunk({ content: 'x' }), chunk({}, { finish_reason: 'stop' }), DONE] }]);

    const result = await run(OPENAI, collector());

    expect(result.usage).toBeNull();
  });
});

describe('a stream that goes wrong', () => {
  /**
   * A truncated answer returned as a complete one is the agent acting on half
   * an instruction, which is worse than an error it can report.
   */
  it('refuses to present a truncated stream as a finished answer', async () => {
    const stream = collector();
    stubFetch([{ sse: [chunk({ content: 'half a sen' })] }]);

    const error = await failure(run(OPENAI, stream));

    expect(error.kind).toBe('malformed');
    expect(error.message).toMatch(/before finishing/i);
    // What did arrive was still shown; it is the claim of completeness that is
    // refused, not the text.
    expect(stream.seen).toEqual(['half a sen']);
  });

  it('names a chunk that is not JSON instead of throwing a parse error', async () => {
    stubFetch([{ sse: ['data: {not json\n\n', DONE] }]);

    const error = await failure(run(OPENAI, collector()));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('malformed');
    expect(error.message).toMatch(/not valid JSON/i);
  });

  it('raises a failure the provider reported mid-stream', async () => {
    stubFetch([
      { sse: [chunk({ content: 'partial' }), `data: ${JSON.stringify({ error: { message: 'upstream exploded' } })}\n\n`] },
    ]);

    const error = await failure(run(OPENAI, collector()));

    expect(error.kind).toBe('server');
    expect(error.message).toContain('upstream exploded');
  });

  it('tells a mid-stream rate limit apart from a mid-stream outage', async () => {
    stubFetch([{ sse: [`data: ${JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } })}\n\n`] }]);

    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('never echoes the key in a mid-stream failure', async () => {
    stubFetch([{ sse: [`data: ${JSON.stringify({ error: { message: 'bad request' } })}\n\n`] }]);

    const error = await failure(
      complete(OPENAI, 'sk-secret', 's', [], TOOLS, new AbortController().signal, null, collector()),
    );

    expect(error.message).not.toContain('sk-secret');
  });

  it('maps the status of a refused streaming request exactly as before', async () => {
    stubFetch([{ status: 401, text: 'nope' }]);
    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'unauthorized' });

    stubFetch([{ status: 503, text: 'boom' }]);
    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'server' });
  });

  it('reports a connection that dropped mid-answer as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(chunk({ content: 'a' })));
                controller.error(new TypeError('network error'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const error = await failure(run(OPENAI, collector()));

    expect(error.kind).toBe('network');
  });
});

describe('falling back to one whole answer', () => {
  /** A proxy that does not implement streaming refuses the parameter. */
  it('retries without streaming when the provider rejects the request', async () => {
    const stream = collector();
    const { calls } = stubFetch([
      { status: 400, text: 'stream is not supported by this deployment' },
      { json: { choices: [{ message: { content: 'whole answer' } }] } },
    ]);

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'whole answer' });

    expect(calls).toHaveLength(2);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[1].body.stream).toBeUndefined();
    expect(stream.seen).toEqual([]);
  });

  /**
   * A turn is many model calls. Asking an endpoint that already said no, once
   * per step, would pay for a discarded request every time.
   */
  it('remembers the refusal, so the next call does not pay for it again', async () => {
    const { calls } = stubFetch([
      { status: 400, text: 'stream is not supported' },
      { json: { choices: [{ message: { content: 'one' } }] } },
    ]);

    await run(OPENAI, collector());
    await run(OPENAI, collector());

    // Three, not four: the second call went straight to the whole-answer path.
    expect(calls).toHaveLength(3);
    expect(calls[2].body.stream).toBeUndefined();
  });

  /**
   * A broken stream is reported as one.
   *
   * Falling back here bills for a second answer and then reports the second
   * call's failure, so a provider sending malformed frames surfaced as a
   * complaint about the base URL — pointing at the one thing that was fine.
   */
  it('does not retry a stream that broke, and says the stream broke', async () => {
    const { calls } = stubFetch([{ sse: ['data: {not json\n\n'] }]);

    const error = await failure(run(OPENAI, collector()));

    expect(error.message).toMatch(/not valid JSON/i);
    expect(calls).toHaveLength(1);
  });

  /** Retrying these would fail the same way, or bill for a second answer. */
  it('does not retry a bad key, a rate limit, or a stream that had begun', async () => {
    stubFetch([{ status: 401, text: 'nope' }]);
    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'unauthorized' });

    forgetStreamingRefusals();
    stubFetch([{ status: 429, text: 'slow down' }]);
    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'rate-limited' });

    forgetStreamingRefusals();
    const { calls } = stubFetch([{ sse: [chunk({ content: 'begun' })] }]);
    await expect(run(OPENAI, collector())).rejects.toMatchObject({ kind: 'malformed' });
    expect(calls).toHaveLength(1);
  });

  /**
   * A gateway that buffers a streamed request and answers under `text/plain`.
   *
   * Read as a stream this finds no frames and is reported as the provider
   * stopping mid-sentence — a hard failure on an answer that was complete.
   * Anything not named as an event stream is a whole body.
   */
  it('reads a buffered answer that came back under the wrong content type', async () => {
    const stream = collector();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'buffered' } }] }), {
            status: 200,
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
          }),
      ),
    );

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'buffered' });
    expect(stream.seen).toEqual([]);
  });

  /** A stream whose header a proxy stripped is still read as a stream. */
  it('still streams a body that arrived with no content type', async () => {
    const stream = collector();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk({ content: 'live' }) + DONE));
            controller.close();
          },
        });
        const response = new Response(body, { status: 200 });
        response.headers.delete('content-type');
        return response;
      }),
    );

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'live' });
    expect(stream.seen).toEqual(['live']);
  });

  /**
   * A provider that accepts `stream: true` and answers with one body anyway is
   * not an error: the answer is in hand and is read with the same parser.
   */
  it('reads a whole body that came back from a streaming request', async () => {
    const stream = collector();
    const { calls } = stubFetch([
      { json: { choices: [{ message: { content: 'buffered' }, finish_reason: 'stop' }] } },
    ]);

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'buffered' });

    // One request, not two: nothing needed asking again.
    expect(calls).toHaveLength(1);
    expect(stream.seen).toEqual([]);
  });
});

describe('stopping a stream', () => {
  it('aborts the underlying request, not just the rendering', async () => {
    const controller = new AbortController();
    const impl = hangingFetch();

    const promise = run(OPENAI, collector(), controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const init = impl.mock.calls[0][1] as RequestInit;
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it('stops mid-answer, keeping what had already arrived', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    stubFetch([{ sse: [chunk({ content: 'one' }), chunk({ content: 'two' })], hold: true }]);

    const promise = complete(
      OPENAI,
      'key',
      's',
      [{ role: 'user', content: 'hi' }],
      TOOLS,
      controller.signal,
      null,
      {
        onText: (text) => {
          seen.push(text);
          // Stopped by the user the instant the first words appear.
          controller.abort();
        },
      },
    );

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['one']);
  });

  /** A cancellation must never be reported as the provider's fault. */
  it('reports a cancellation as a cancellation, not a provider failure', async () => {
    const controller = new AbortController();
    stubFetch([{ sse: [chunk({ content: 'x' })], hold: true }]);

    const promise = run(OPENAI, collector(), controller.signal);
    await Promise.resolve();
    controller.abort();

    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('leaves the next request able to stream', async () => {
    const controller = new AbortController();
    stubFetch([{ sse: [chunk({ content: 'x' })], hold: true }]);
    const promise = run(OPENAI, collector(), controller.signal);
    controller.abort();
    await promise.catch(() => undefined);

    const stream = collector();
    stubFetch([{ sse: [chunk({ content: 'fresh' }), DONE] }]);

    await expect(run(OPENAI, stream)).resolves.toMatchObject({ text: 'fresh' });
    expect(stream.seen).toEqual(['fresh']);
  });
});

describe('the deadline on a stream', () => {
  /**
   * The timeout exists to stop a task hanging forever, and a streamed response
   * arrives in two parts — headers, then body. Disarming it when the headers
   * land would leave the body unbounded, which is the same failure in a new
   * place. The policy is unchanged: one deadline over both.
   */
  it('still applies once the body has started, and is the same length', async () => {
    vi.useFakeTimers();
    const stream = collector();
    stubFetch([{ sse: [chunk({ content: 'starts well' })], hold: true }]);

    const promise = run(OPENAI, stream);
    const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    await assertion;

    expect(stream.seen).toEqual(['starts well']);
  });

  it('does not fire on a stream that finished in time', async () => {
    vi.useFakeTimers();
    stubFetch([{ sse: [chunk({ content: 'quick' }), DONE] }]);

    await expect(run(OPENAI, collector())).resolves.toMatchObject({ text: 'quick' });
    // Nothing is left armed to reject a settled task later.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('an Anthropic stream', () => {
  const opening = event('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 25, output_tokens: 1 } },
  });

  it('hands over text deltas as they arrive and closes on message_stop', async () => {
    const stream = collector();
    stubFetch([
      {
        sse: [
          opening,
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
          event('content_block_stop', { index: 0 }),
          event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
          event('message_stop', { type: 'message_stop' }),
        ],
      },
    ]);

    const result = await run(ANTHROPIC, stream);

    expect(stream.seen).toEqual(['Hel', 'Hello']);
    expect(result).toMatchObject({
      text: 'Hello',
      stopReason: 'end_turn',
      usage: { inputTokens: 25, outputTokens: 7 },
    });
    // The same block array the whole-response path returns.
    expect(result.raw).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('assembles a tool call from partial JSON deltas', async () => {
    stubFetch([
      {
        sse: [
          opening,
          event('content_block_start', {
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
          }),
          event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } }),
          event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ':"a.ts"}' } }),
          event('content_block_stop', { index: 0 }),
          event('message_delta', { delta: { stop_reason: 'tool_use' } }),
          event('message_stop', {}),
        ],
      },
    ]);

    const result = await run(ANTHROPIC, collector());

    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.raw).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  it('ignores the pings that hold a long generation open', async () => {
    const stream = collector();
    stubFetch([
      {
        sse: [
          opening,
          'event: ping\ndata: {"type":"ping"}\n\n',
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
          'event: ping\ndata: {"type":"ping"}\n\n',
          event('message_stop', {}),
        ],
      },
    ]);

    await expect(run(ANTHROPIC, stream)).resolves.toMatchObject({ text: 'ok' });
    expect(stream.seen).toEqual(['ok']);
  });

  it('raises an error event rather than returning what it had', async () => {
    stubFetch([
      {
        sse: [
          opening,
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }),
          event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
        ],
      },
    ]);

    const error = await failure(run(ANTHROPIC, collector()));

    expect(error.kind).toBe('server');
    expect(error.message).toContain('Overloaded');
  });

  it('refuses a stream that stopped before message_stop', async () => {
    stubFetch([
      {
        sse: [
          opening,
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'cut off' } }),
        ],
      },
    ]);

    await expect(run(ANTHROPIC, collector())).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('asks for a stream with the flag Anthropic expects', async () => {
    const { calls } = stubFetch([{ sse: [opening, event('message_stop', {})] }]);

    await run(ANTHROPIC, collector());

    expect(calls[0].body.stream).toBe(true);
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('key');
    expect(calls[0].url).not.toContain('key=');
  });
});
