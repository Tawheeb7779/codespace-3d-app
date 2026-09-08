// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  complete,
  type HostedEndpoint,
  type ProviderConfig,
} from '@/lib/ai/provider';

/**
 * The browser half of the hosted assistant.
 *
 * The deployment's Gemini key lives in an Edge Function. What this side has to
 * get right is narrow and absolute: send the session, never a provider key;
 * send it to our function, never to Google; and leave every bring-your-own-key
 * provider exactly as it was.
 *
 * The function's own half — who may call it, how often, and that the key never
 * comes back out — is tested where it runs, in
 * `supabase/functions/ai-proxy/index.test.ts`.
 */

const GEMINI: ProviderConfig = { kind: 'gemini', model: 'gemini-2.5-flash', baseUrl: '' };

const HOSTED: HostedEndpoint = {
  url: 'https://project.supabase.co/functions/v1/ai-proxy',
  headers: { authorization: 'Bearer session-token', apikey: 'anon-key' },
};

const REPLY = JSON.stringify({
  choices: [{ message: { content: 'وعليكم السلام' }, finish_reason: 'stop' }],
});

function respond(body: string, init: ResponseInit = {}) {
  const fetchSpy = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(body, { status: 200, ...init }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const sent = (spy: ReturnType<typeof respond>, index = 0) => ({
  url: String(spy.mock.calls[index][0]),
  init: spy.mock.calls[index][1],
  headers: (spy.mock.calls[index][1].headers ?? {}) as Record<string, string>,
});

const call = (config: ProviderConfig, key: string, hosted: HostedEndpoint | null) =>
  complete(
    config,
    key,
    'system',
    [{ role: 'user', content: 'السلام عليكم' }],
    [],
    new AbortController().signal,
    hosted,
  );

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected the provider call to fail, but it resolved');
}

afterEach(() => vi.unstubAllGlobals());

describe('a hosted completion', () => {
  it('goes to our function, not to Google', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, '', HOSTED);

    expect(sent(fetchSpy).url).toBe(HOSTED.url);
    expect(sent(fetchSpy).url).not.toContain('generativelanguage');
  });

  it('sends the session, and no provider key', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, '', HOSTED);

    const { headers } = sent(fetchSpy);
    expect(headers.authorization).toBe('Bearer session-token');
    expect(headers.apikey).toBe('anon-key');
  });

  /**
   * The one that matters. A key left over from a Local Mode session — or set by
   * anything else — must not ride along to a hosted endpoint, where it would be
   * a Google credential sent to a server that has no business seeing one.
   */
  it('never forwards a stale local key to the hosted endpoint', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, 'AIza-left-over-from-local-mode', HOSTED);

    const request = JSON.stringify(sent(fetchSpy));
    expect(request).not.toContain('AIza-left-over-from-local-mode');
    expect(sent(fetchSpy).headers.authorization).toBe('Bearer session-token');
  });

  it('needs no key at all, where bring-your-own-key would refuse', async () => {
    respond(REPLY);

    const result = await call(GEMINI, '', HOSTED);

    expect(result.text).toBe('وعليكم السلام');
  });

  it('still refuses without a key when there is no host to ask', async () => {
    respond(REPLY);

    expect((await failure(call(GEMINI, '', null))).kind).toBe('not-configured');
  });

  it('sends the same chat-completions body the direct path sends', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, '', HOSTED);

    const body = JSON.parse(String(sent(fetchSpy).init.body));
    expect(body.model).toBe('gemini-2.5-flash');
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'السلام عليكم' },
    ]);
  });

  it('carries tool calls back, so the agent loop is unchanged', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.ts"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const result = await call(GEMINI, '', HOSTED);

    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'write_file', input: { path: 'a.ts' } }]);
  });
});

describe('what the panel shows when the host refuses', () => {
  it('reads the function’s 401 as a session problem, not a key problem', async () => {
    respond(JSON.stringify({ message: 'Sign in to use the assistant.' }), { status: 401 });

    const error = await failure(call(GEMINI, '', HOSTED));

    expect(error.kind).toBe('unauthorized');
  });

  it('reads a 429 as a rate limit, with the retry the function gave', async () => {
    respond(JSON.stringify({ message: 'Slow down.' }), {
      status: 429,
      headers: { 'retry-after': '60' },
    });

    const error = await failure(call(GEMINI, '', HOSTED));

    expect(error.kind).toBe('rate-limited');
    expect(error.retryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('reads a 413 as a request problem rather than a bad key', async () => {
    respond(JSON.stringify({ message: 'That request is too large.' }), { status: 413 });

    expect((await failure(call(GEMINI, '', HOSTED))).kind).toBe('request');
  });

  it('reads the function being down as a server fault', async () => {
    respond(JSON.stringify({ message: 'The assistant is unavailable.' }), { status: 503 });

    expect((await failure(call(GEMINI, '', HOSTED))).kind).toBe('server');
  });
});

describe('the providers that were already there', () => {
  it('are untouched by a hosted endpoint being available', async () => {
    const fetchSpy = respond(REPLY);

    // Anthropic keeps its own transport and its own credential…
    await failure(call({ kind: 'anthropic', model: 'm', baseUrl: '' }, 'sk-anthropic', HOSTED));
    expect(sent(fetchSpy).url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent(fetchSpy).headers['x-api-key']).toBe('sk-anthropic');

    // …and an OpenAI-compatible endpoint keeps its base URL and bearer.
    await call({ kind: 'openai', model: 'm', baseUrl: 'https://proxy.test/v1' }, 'sk-proxy', HOSTED);
    expect(sent(fetchSpy, 1).url).toBe('https://proxy.test/v1/chat/completions');
    expect(sent(fetchSpy, 1).headers.authorization).toBe('Bearer sk-proxy');
  });

  it('leave Gemini on the direct path when nothing is hosting it', async () => {
    const fetchSpy = respond(REPLY);

    await call(GEMINI, 'AIza-my-own-key', null);

    expect(sent(fetchSpy).url).toContain('generativelanguage.googleapis.com/v1beta/openai');
    expect(sent(fetchSpy).headers.authorization).toBe('Bearer AIza-my-own-key');
  });
});
