// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_BASE_URL,
  ProviderError,
  complete,
  modelForKind,
  resolveBaseUrl,
  type ProviderConfig,
} from '@/lib/ai/provider';

/**
 * Talking to Gemini.
 *
 * Every assertion here is anchored to a real response from
 * `generativelanguage.googleapis.com`, captured while diagnosing a report of
 * "HTTP 401 or 403" from the assistant:
 *
 *   POST /v1beta/models/…:generateContent    with no key   -> 403 PERMISSION_DENIED
 *                                                              "Method doesn't allow
 *                                                               unregistered callers"
 *   POST /v1beta/openai/chat/completions     bad key       -> 400 INVALID_ARGUMENT
 *                                                              "API key not valid"
 *   POST /v1beta/openai/chat/completions     no auth       -> 400 INVALID_ARGUMENT
 *                                                              "Missing or invalid
 *                                                               Authorization header"
 *   POST api.anthropic.com/v1/messages       Gemini key    -> 401 invalid x-api-key
 *
 * So the two statuses have two different causes, and neither is "the key is
 * wrong": 401 is Anthropic being handed a Google key, and 403 is Google being
 * handed no key at all because the request never reached the surface that reads
 * the `Authorization` header. Both were reachable because there was no Gemini
 * provider to choose.
 */

const GEMINI: ProviderConfig = { kind: 'gemini', model: DEFAULT_GEMINI_MODEL, baseUrl: '' };

const call = (config: ProviderConfig, key = 'test-key') =>
  complete(
    config,
    key,
    'system',
    [{ role: 'user', content: 'Hello' }],
    [],
    new AbortController().signal,
  );

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected the provider call to fail, but it resolved');
}

/** Answer every request with this body, and hand back the spy. */
function respond(body: string, init: ResponseInit = {}) {
  const fetchSpy = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(body, { status: 200, ...init }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** The URL and the request options of the nth call, typed. */
const sent = (spy: ReturnType<typeof respond>, index = 0) => ({
  url: String(spy.mock.calls[index][0]),
  init: spy.mock.calls[index][1],
});

const REPLY = JSON.stringify({
  choices: [{ message: { content: 'وعليكم السلام' }, finish_reason: 'stop' }],
});

afterEach(() => vi.unstubAllGlobals());

describe('where a Gemini request is sent', () => {
  /**
   * The regression that produced the 403. Google serves two APIs from this
   * host: the native REST API under `/v1beta`, which authenticates by
   * `x-goog-api-key`, and the OpenAI-compatible one under `/v1beta/openai`,
   * which reads `Authorization: Bearer`. This transport only ever sends a
   * bearer token, so dropping the `/openai` segment means the key is not read,
   * the caller has no identity, and Google answers 403.
   */
  it('goes to the OpenAI-compatible surface, not the native REST API', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI);

    const { url } = sent(fetchSpy);
    expect(url).toBe(`${GEMINI_BASE_URL}/chat/completions`);
    expect(url).toContain('/v1beta/openai/');
  });

  it('sends the key as a bearer token, which is the header that surface reads', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, 'a-secret');

    const { init } = sent(fetchSpy);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-secret');
  });

  it('never puts the key in the URL, where a log or a referrer would keep it', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, 'a-secret');

    expect(sent(fetchSpy).url).not.toContain('a-secret');
    // The native API's own convention, which must not creep in here.
    expect(sent(fetchSpy).url).not.toMatch(/[?&]key=/);
  });

  it('lets a proxy of your own stand in front of Google', () => {
    expect(resolveBaseUrl({ ...GEMINI, baseUrl: 'https://gw.internal/v1/' })).toBe(
      'https://gw.internal/v1',
    );
    expect(resolveBaseUrl(GEMINI)).toBe(GEMINI_BASE_URL);
  });
});

describe('a Gemini request that is refused', () => {
  it('refuses to send at all with no key, rather than asking Google about headers', async () => {
    const fetchSpy = respond(REPLY);

    const error = await failure(call(GEMINI, ''));

    expect(error.kind).toBe('not-configured');
    expect(error.message).toMatch(/Gemini API key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Google says a rejected key with 400, not 401. Read as a bare 400 it looks
   * like a malformed request and sends you to your prompt instead of your key.
   */
  it('reads Google’s 400 about the key as a rejected key', async () => {
    respond(
      JSON.stringify({
        error: { code: 400, message: 'API key not valid. Please pass a valid API key.' },
      }),
      { status: 400 },
    );

    const error = await failure(call(GEMINI));

    expect(error.kind).toBe('unauthorized');
    expect(error.message).toMatch(/Gemini rejected the API key/);
  });

  it('reads a missing Authorization header the same way', async () => {
    respond(JSON.stringify({ error: { message: 'Missing or invalid Authorization header.' } }), {
      status: 400,
    });

    expect((await failure(call(GEMINI))).kind).toBe('unauthorized');
  });

  it('still reports a genuinely malformed request as one', async () => {
    respond(JSON.stringify({ error: { message: 'Invalid value at contents[0]' } }), {
      status: 400,
    });

    const error = await failure(call(GEMINI));

    expect(error.kind).toBe('request');
    expect(error.kind).not.toBe('unauthorized');
  });

  it('keeps 401 and 403 as rejected keys, named for Gemini', async () => {
    for (const status of [401, 403]) {
      respond(JSON.stringify({ error: { message: 'nope' } }), { status });
      const error = await failure(call(GEMINI));
      expect(error.kind).toBe('unauthorized');
      expect(error.message).toContain('Gemini');
    }
  });

  /**
   * A 403 has more than one cause, and they are fixed in different places:
   * the API switched off for the project, a key restricted to referrers this
   * origin is not one of, or no key reaching Google at all. "Check your key"
   * alone sends someone to the only one of the three that might be fine.
   */
  it('passes Google’s own reason through, so a 403 can be told apart', async () => {
    respond(
      JSON.stringify({
        error: {
          code: 403,
          message: 'Generative Language API has not been used in project 123 before or it is disabled.',
          status: 'SERVICE_DISABLED',
        },
      }),
      { status: 403 },
    );

    const error = await failure(call(GEMINI));

    expect(error.kind).toBe('unauthorized');
    expect(error.message).toContain('has not been used in project');
    expect(error.message).toContain('SERVICE_DISABLED');
  });

  /** Google's OpenAI-compatible surface wraps its error in an array. */
  it('reads the array-wrapped error that surface actually returns', async () => {
    respond(JSON.stringify([{ error: { code: 400, message: 'Please pass a valid API key' } }]), {
      status: 400,
    });

    const error = await failure(call(GEMINI));

    expect(error.kind).toBe('unauthorized');
    expect(error.message).toContain('Please pass a valid API key');
  });

  it('never lets a refusal body run away with the panel', async () => {
    respond(JSON.stringify({ error: { message: `${'x'.repeat(5000)}\n\nmore` } }), { status: 403 });

    const error = await failure(call(GEMINI));

    expect(error.message.length).toBeLessThan(300);
    expect(error.message).not.toContain('\n');
  });

  it('reports a wrong model as the request error it is, not as a bad key', async () => {
    respond(JSON.stringify({ error: { message: 'models/nope is not found' } }), { status: 404 });

    expect((await failure(call({ ...GEMINI, model: 'nope' }))).kind).toBe('request');
  });
});

describe('a Gemini request that succeeds', () => {
  it('returns the reply, including non-Latin text', async () => {
    respond(REPLY);

    const result = await call(GEMINI);

    expect(result.text).toBe('وعليكم السلام');
    expect(result.stopReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
  });

  it('sends the prompt and the model the agent asked for', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI);

    const body = JSON.parse(String(sent(fetchSpy).init.body));
    expect(body.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('carries tool calls through, so the agent loop works as on any provider', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const result = await call(GEMINI);

    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }]);
  });
});

describe('choosing a provider', () => {
  /**
   * The other half of the reported failure: the model field kept whatever the
   * previous provider suggested, so a switch to Gemini asked Google for
   * `claude-sonnet-5`.
   */
  it('carries the new provider’s model when the old one was only a suggestion', () => {
    expect(modelForKind('gemini', 'claude-sonnet-5')).toBe(DEFAULT_GEMINI_MODEL);
    expect(modelForKind('gemini', '')).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('leaves a model the user typed alone', () => {
    expect(modelForKind('gemini', 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(modelForKind('anthropic', 'claude-opus-4-1')).toBe('claude-opus-4-1');
  });

  it('does not disturb the providers that already worked', async () => {
    const fetchSpy = respond(REPLY);

    await call({ kind: 'openai', model: 'm', baseUrl: 'https://proxy.test/v1' });
    expect(sent(fetchSpy).url).toBe('https://proxy.test/v1/chat/completions');

    // An OpenAI-compatible endpoint still needs its base URL, and Anthropic
    // still goes to Anthropic — it rejects this OpenAI-shaped body, which is
    // itself the point: the two transports stayed separate.
    expect((await failure(call({ kind: 'openai', model: 'm', baseUrl: '' }))).kind).toBe(
      'not-configured',
    );
    await failure(call({ kind: 'anthropic', model: 'm', baseUrl: '' }));
    expect(sent(fetchSpy, 1).url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('still refuses to run with nothing connected', async () => {
    respond(REPLY);

    expect((await failure(call({ kind: 'none', model: '', baseUrl: '' }))).kind).toBe(
      'not-configured',
    );
  });
});
