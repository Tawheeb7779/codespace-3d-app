// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  REQUEST_TIMEOUT_MS,
  complete,
  type ProviderConfig,
} from '@/lib/ai/provider';

/**
 * How the agent behaves when the model provider misbehaves.
 *
 * Each of these was a way for a task to end badly: a provider that never
 * answers left the panel running forever, an HTML error page from a proxy
 * surfaced as `Unexpected token <`, and a rate limit was indistinguishable
 * from a bad key. The transport is exercised through `complete`, so the
 * mapping under test is the one the agent actually uses.
 */

const OPENAI: ProviderConfig = { kind: 'openai', model: 'm', baseUrl: 'http://provider.test/v1' };
const ANTHROPIC: ProviderConfig = { kind: 'anthropic', model: 'm', baseUrl: '' };

const call = (config = OPENAI, signal = new AbortController().signal) =>
  complete(config, 'key', 'system', [{ role: 'user', content: 'hi' }], [], signal);

/** The rejection, typed — a call that resolves here is itself the failure. */
async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected the provider call to fail, but it resolved');
}

function respond(body: string, init: ResponseInit = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, ...init })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a provider that will not answer', () => {
  it('gives up rather than leaving the task running forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const promise = call();
    const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    await assertion;
  });

  /** A cancelled task must read as cancelled, never as a provider failure. */
  it('reports the user cancelling as a cancellation, not an error', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const promise = call(OPENAI, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('explains an unreachable endpoint by host, never echoing the URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await failure(
      call({ ...OPENAI, baseUrl: 'http://provider.test/v1?key=supersecret' }),
    );
    expect(error.kind).toBe('network');
    expect(error.message).toContain('provider.test');
    expect(error.message).not.toContain('supersecret');
  });
});

describe('a provider that answers badly', () => {
  it('names a non-JSON body instead of throwing a parse error', async () => {
    respond('<!doctype html><html><body>502 Bad Gateway</body></html>');
    const error = await failure(call());
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('malformed');
    expect(error.message).toMatch(/non-JSON/);
  });

  it('handles JSON with no choices, and no message inside a choice', async () => {
    respond(JSON.stringify({ choices: [] }));
    await expect(call()).rejects.toMatchObject({ kind: 'malformed' });
    respond(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }));
    await expect(call()).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('handles an Anthropic response with no content block', async () => {
    respond(JSON.stringify({ stop_reason: 'end_turn' }));
    await expect(call(ANTHROPIC)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('names the tool when the model emits unparseable arguments', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: '1', function: { name: 'edit_file', arguments: '{not json' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const error = await failure(call());
    expect(error.kind).toBe('malformed');
    expect(error.message).toContain('edit_file');
  });

  it('refuses a tool call with no name rather than dispatching an empty one', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: '1', function: { arguments: '{}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    await expect(call()).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('tolerates a missing finish_reason', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
    await expect(call()).resolves.toMatchObject({ text: 'hello', stopReason: 'stop' });
  });
});

describe('provider failures are told apart', () => {
  it('separates a bad key from a rate limit from an outage', async () => {
    respond('nope', { status: 401 });
    await expect(call()).rejects.toMatchObject({ kind: 'unauthorized' });

    respond('slow down', { status: 429, headers: { 'retry-after': '30' } });
    const limited = await failure(call());
    expect(limited.kind).toBe('rate-limited');
    expect(limited.retryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(limited.message).toMatch(/30s/);

    respond('boom', { status: 503 });
    await expect(call()).rejects.toMatchObject({ kind: 'server' });
  });

  it('handles a rate limit with no retry-after header', async () => {
    respond('slow down', { status: 429 });
    const limited = await failure(call());
    expect(limited.kind).toBe('rate-limited');
    expect(limited.retryAt).toBeNull();
  });

  it('refuses to run at all with nothing configured', async () => {
    await expect(
      complete({ kind: 'none', model: '', baseUrl: '' }, '', 's', [], [], new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'not-configured' });

    await expect(call({ ...OPENAI, baseUrl: '' })).rejects.toMatchObject({
      kind: 'not-configured',
    });

    await expect(
      complete(ANTHROPIC, '', 's', [], [], new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'not-configured' });
  });
});

describe('credentials in requests', () => {
  it('sends the key in a header, never in the URL', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', spy);
    await call();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain('key');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key');
  });
});
