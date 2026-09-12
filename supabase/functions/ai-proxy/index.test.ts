/**
 * The hosted assistant's boundary, executed rather than described.
 *
 *   deno test --allow-env --allow-net supabase/functions/ai-proxy/index.test.ts
 *
 * This drives the real `handler` the deployment serves. Nothing is
 * re-implemented for the test: `fetch` is stubbed, so Supabase's auth check,
 * the rate-limit count, the usage insert and the Gemini call are all
 * intercepted at the wire, and everything between them is the shipping code.
 *
 * The deployment's key is the asset. Every case below either establishes that
 * a caller cannot spend it, or that it does not come back out.
 */

Deno.env.set('AI_PROXY_TEST', '1');
Deno.env.set('SUPABASE_URL', 'https://project.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-tests');

const SECRET = 'gemini-key-that-must-never-escape';

import { handler } from './index.ts';

/**
 * Assertions, written out rather than imported.
 *
 * `jsr:@std/assert` is unreachable from the environment this suite has to run
 * in, and a boundary this important being untested because a helper library
 * would not download is the wrong trade. These are three functions.
 */
function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(message ?? `expected ${b}, got ${a}`);
}

function assertStringIncludes(actual: string, needle: string): void {
  if (!actual.includes(needle)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${needle}`);
}

// ---------------------------------------------------------------------------
// A stubbed world
// ---------------------------------------------------------------------------

interface World {
  /** Rows already in the ledger for the caller, per window. */
  countsInWindow: number[];
  /** What the auth endpoint says. */
  user: { id: string; email: string } | null;
  authStatus: number;
  /** What Gemini answers. */
  upstreamStatus: number;
  upstreamBody: string;
  /** Response headers, so a case can answer as an event stream. */
  upstreamHeaders: Record<string, string>;
}

interface Seen {
  upstream: { url: string; init: RequestInit } | null;
  inserted: Record<string, unknown>[];
  countUrls: string[];
  authTokens: string[];
}

let world: World;
let seen: Seen;

const realFetch = globalThis.fetch;

function install(overrides: Partial<World> = {}) {
  world = {
    countsInWindow: [0, 0],
    user: { id: 'user-real', email: 'real@example.test' },
    authStatus: 200,
    upstreamStatus: 200,
    upstreamBody: JSON.stringify({
      choices: [{ message: { content: 'وعليكم السلام' }, finish_reason: 'stop' }],
    }),
    upstreamHeaders: {},
    ...overrides,
  };
  seen = { upstream: null, inserted: [], countUrls: [], authTokens: [] };
  let countCall = 0;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(
      (input instanceof Request ? input.headers : init?.headers) as HeadersInit,
    );

    if (url.includes('/auth/v1/user')) {
      seen.authTokens.push(headers.get('authorization') ?? '');
      if (world.authStatus !== 200 || !world.user) {
        return Promise.resolve(new Response('{}', { status: world.authStatus || 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify(world.user), { status: 200 }));
    }

    if (url.includes('/rest/v1/ai_requests')) {
      if ((init?.method ?? 'GET') === 'POST') {
        seen.inserted.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      seen.countUrls.push(url);
      const total = world.countsInWindow[Math.min(countCall++, world.countsInWindow.length - 1)];
      return Promise.resolve(
        new Response(null, { status: 200, headers: { 'content-range': `0-0/${total}` } }),
      );
    }

    if (url.includes('generativelanguage.googleapis.com')) {
      seen.upstream = { url, init: init ?? {} };
      return Promise.resolve(
        new Response(world.upstreamBody, {
          status: world.upstreamStatus,
          headers: world.upstreamHeaders,
        }),
      );
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function restore() {
  globalThis.fetch = realFetch;
  Deno.env.delete('AI_RATE_LIMIT_PER_MINUTE');
  Deno.env.delete('AI_RATE_LIMIT_PER_DAY');
  Deno.env.delete('AI_MAX_REQUEST_BYTES');
  Deno.env.delete('AI_MAX_OUTPUT_TOKENS');
  Deno.env.delete('GEMINI_ALLOWED_MODELS');
  Deno.env.delete('GEMINI_MODEL');
  Deno.env.set('GEMINI_API_KEY', SECRET);
}

Deno.env.set('GEMINI_API_KEY', SECRET);

const ask = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer good' }) =>
  handler(
    new Request('https://project.supabase.co/functions/v1/ai-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const CHAT = { messages: [{ role: 'user', content: 'Hello' }] };

/** Run a case with a fresh stubbed world, and always put the world back. */
async function withWorld(overrides: Partial<World>, run: () => Promise<void>) {
  install(overrides);
  try {
    await run();
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

Deno.test('an authenticated request reaches Gemini and comes back', async () => {
  await withWorld({}, async () => {
    const response = await ask(CHAT);

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.choices[0].message.content, 'وعليكم السلام');
    assert(seen.upstream, 'the upstream was never called');
  });
});

Deno.test('no Authorization header is a clean 401, and nothing is spent', async () => {
  await withWorld({}, async () => {
    const response = await ask(CHAT, {});

    assertEquals(response.status, 401);
    assertEquals(seen.upstream, null);
    assertEquals(seen.inserted.length, 0);
  });
});

Deno.test('a token Supabase rejects is a 401, not a request to Gemini', async () => {
  await withWorld({ authStatus: 401, user: null }, async () => {
    const response = await ask(CHAT, { authorization: 'Bearer forged' });

    assertEquals(response.status, 401);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('the token is verified by Supabase rather than decoded here', async () => {
  await withWorld({}, async () => {
    await ask(CHAT, { authorization: 'Bearer opaque-token' });

    assertEquals(seen.authTokens, ['Bearer opaque-token']);
  });
});

/**
 * The impersonation case. A client that sends someone else's id — or a fresh
 * one each request, to shed its own rate limit — must be counted as itself.
 */
Deno.test('a user id in the body is ignored; usage is filed under the verified user', async () => {
  await withWorld({}, async () => {
    await ask({ ...CHAT, userId: 'victim', user_id: 'victim', sub: 'victim' });

    assertEquals(seen.inserted[0].user_id, 'user-real');
    for (const url of seen.countUrls) assertStringIncludes(url, 'user_id=eq.user-real');
    for (const url of seen.countUrls) assert(!url.includes('victim'), url);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

Deno.test('a caller under the allowance is served', async () => {
  await withWorld({ countsInWindow: [59, 100] }, async () => {
    Deno.env.set('AI_RATE_LIMIT_PER_MINUTE', '60');
    assertEquals((await ask(CHAT)).status, 200);
  });
});

Deno.test('a caller over the per-minute allowance gets 429 and a retry-after', async () => {
  await withWorld({ countsInWindow: [60, 100] }, async () => {
    Deno.env.set('AI_RATE_LIMIT_PER_MINUTE', '60');

    const response = await ask(CHAT);

    assertEquals(response.status, 429);
    assertEquals(response.headers.get('retry-after'), '60');
    assertEquals(seen.upstream, null);
  });
});

Deno.test('the daily allowance is enforced separately from the per-minute one', async () => {
  await withWorld({ countsInWindow: [1, 1500] }, async () => {
    const response = await ask(CHAT);

    assertEquals(response.status, 429);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('the limits are configurable', async () => {
  await withWorld({ countsInWindow: [3, 3] }, async () => {
    Deno.env.set('AI_RATE_LIMIT_PER_MINUTE', '3');
    assertEquals((await ask(CHAT)).status, 429);
  });
});

/**
 * An agent turn is up to MAX_STEPS (12) calls back to back. A default that
 * cannot carry one would make the product unusable rather than protected.
 */
Deno.test('the default per-minute allowance carries several whole agent turns', async () => {
  await withWorld({ countsInWindow: [35, 100] }, async () => {
    assertEquals((await ask(CHAT)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Request limits
// ---------------------------------------------------------------------------

Deno.test('an oversized body is refused with 413 before it is parsed', async () => {
  await withWorld({}, async () => {
    Deno.env.set('AI_MAX_REQUEST_BYTES', '512');

    const response = await ask({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });

    assertEquals(response.status, 413);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('a body that lies about its length is still stopped at the cap', async () => {
  await withWorld({}, async () => {
    Deno.env.set('AI_MAX_REQUEST_BYTES', '512');
    const huge = JSON.stringify({ messages: [{ role: 'user', content: 'y'.repeat(4000) }] });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });

    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/ai-proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
        body: stream,
        // @ts-expect-error Deno needs this to send a stream body.
        duplex: 'half',
      }),
    );

    assertEquals(response.status, 413);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('a conversation with no messages is refused', async () => {
  await withWorld({}, async () => {
    assertEquals((await ask({ messages: [] })).status, 400);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('the output length is capped by the server, not by the caller', async () => {
  await withWorld({}, async () => {
    Deno.env.set('AI_MAX_OUTPUT_TOKENS', '777');

    await ask({ ...CHAT, max_tokens: 999999 });

    const sent = JSON.parse(String(seen.upstream!.init.body));
    assertEquals(sent.max_tokens, 777);
  });
});

/**
 * The upstream body is rebuilt rather than forwarded, so a caller cannot append
 * parameters we would be billed for.
 *
 * `stream` used to be on this list. It is allowed now — the client grew a real
 * streaming path — but as a normalised literal rather than the caller's value,
 * which the next case covers.
 */
Deno.test('unknown fields never reach Gemini', async () => {
  await withWorld({}, async () => {
    await ask({ ...CHAT, n: 8, candidateCount: 8, safetySettings: [] });

    const sent = JSON.parse(String(seen.upstream!.init.body));
    assertEquals(sent.n, undefined);
    assertEquals(sent.candidateCount, undefined);
    assertEquals(sent.safetySettings, undefined);
    assertEquals(Object.keys(sent).sort(), ['max_tokens', 'messages', 'model']);
  });
});

Deno.test('a stream request is forwarded as the literal true', async () => {
  await withWorld({}, async () => {
    await ask({ ...CHAT, stream: true });

    const sent = JSON.parse(String(seen.upstream!.init.body));
    assertEquals(sent.stream, true);
  });
});

/** Anything that is not exactly `true` is not a request to stream. */
Deno.test('a non-boolean stream value is dropped rather than passed on', async () => {
  for (const value of ['true', 1, {}, [], 'yes']) {
    await withWorld({}, async () => {
      await ask({ ...CHAT, stream: value });
      const sent = JSON.parse(String(seen.upstream!.init.body));
      assertEquals(sent.stream, undefined, `stream: ${JSON.stringify(value)} was forwarded`);
    });
  }
});

Deno.test('omitting stream still sends a whole-response request', async () => {
  await withWorld({}, async () => {
    await ask(CHAT);
    const sent = JSON.parse(String(seen.upstream!.init.body));
    assertEquals(sent.stream, undefined);
  });
});

Deno.test('tools are carried through, so the agent loop still works', async () => {
  await withWorld({}, async () => {
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }];

    await ask({ ...CHAT, tools });

    assertEquals(JSON.parse(String(seen.upstream!.init.body)).tools, tools);
  });
});

// ---------------------------------------------------------------------------
// Model policy
// ---------------------------------------------------------------------------

Deno.test('the default model is used when none is asked for', async () => {
  await withWorld({}, async () => {
    await ask(CHAT);
    assertEquals(JSON.parse(String(seen.upstream!.init.body)).model, 'gemini-2.5-flash');
  });
});

Deno.test('a model the deployment does not allow is refused', async () => {
  await withWorld({}, async () => {
    Deno.env.set('GEMINI_ALLOWED_MODELS', 'gemini-2.5-flash,gemini-2.5-pro');

    const response = await ask({ ...CHAT, model: 'gemini-1.0-ultra-expensive' });

    assertEquals(response.status, 400);
    assertEquals(seen.upstream, null);
  });
});

Deno.test('an allowed model is honoured, and the list is configurable', async () => {
  await withWorld({}, async () => {
    Deno.env.set('GEMINI_ALLOWED_MODELS', 'gemini-2.5-flash,gemini-2.5-pro');

    await ask({ ...CHAT, model: 'gemini-2.5-pro' });

    assertEquals(JSON.parse(String(seen.upstream!.init.body)).model, 'gemini-2.5-pro');
  });
});

Deno.test('the default model itself is configurable', async () => {
  await withWorld({}, async () => {
    Deno.env.set('GEMINI_MODEL', 'gemini-3.0-flash');

    await ask(CHAT);

    assertEquals(JSON.parse(String(seen.upstream!.init.body)).model, 'gemini-3.0-flash');
  });
});

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

Deno.test('the key goes to Gemini and nowhere else', async () => {
  await withWorld({}, async () => {
    await ask(CHAT);

    const headers = new Headers(seen.upstream!.init.headers as HeadersInit);
    assertEquals(headers.get('authorization'), `Bearer ${SECRET}`);
    // Not in the URL, where a log or a referrer would keep it.
    assert(!seen.upstream!.url.includes(SECRET));
    // Not in the ledger.
    assert(!JSON.stringify(seen.inserted).includes(SECRET));
  });
});

Deno.test('no response body ever contains the key', async () => {
  const cases: Array<[string, Partial<World>, unknown]> = [
    ['success', {}, CHAT],
    ['upstream rejects the key', { upstreamStatus: 403, upstreamBody: `{"error":{"message":"key ${SECRET} is invalid"}}` }, CHAT],
    ['upstream 500', { upstreamStatus: 500, upstreamBody: `${SECRET} blew up` }, CHAT],
    ['upstream 429', { upstreamStatus: 429, upstreamBody: `slow down ${SECRET}` }, CHAT],
    ['bad model', {}, { ...CHAT, model: 'nope' }],
    ['unauthenticated', {}, CHAT],
  ];

  for (const [name, overrides, body] of cases) {
    await withWorld(overrides, async () => {
      const response = name === 'unauthenticated' ? await ask(body, {}) : await ask(body);
      const text = await response.text();
      assert(!text.includes(SECRET), `${name} leaked the key: ${text}`);
    });
  }
});

Deno.test('an upstream refusal of our key is an operator problem, not a user message', async () => {
  await withWorld(
    { upstreamStatus: 403, upstreamBody: '{"error":{"message":"API key not valid"}}' },
    async () => {
      const response = await ask(CHAT);

      assertEquals(response.status, 503);
      const body = await response.json();
      // Not "your key is wrong" — the user has no key.
      assert(!/API key not valid/.test(body.message), body.message);
      assertStringIncludes(body.message, 'administrator');
    },
  );
});

Deno.test('an upstream complaint about the request is passed on so it can be fixed', async () => {
  await withWorld(
    { upstreamStatus: 400, upstreamBody: '{"error":{"message":"Invalid value at contents[0]"}}' },
    async () => {
      const response = await ask(CHAT);

      assertEquals(response.status, 400);
      assertStringIncludes((await response.json()).message, 'Invalid value at contents');
    },
  );
});

Deno.test('an upstream rate limit is reported as one', async () => {
  await withWorld({ upstreamStatus: 429, upstreamBody: '{}' }, async () => {
    assertEquals((await ask(CHAT)).status, 429);
  });
});

Deno.test('an upstream outage is a 502, with no detail', async () => {
  await withWorld({ upstreamStatus: 500, upstreamBody: 'internal stack trace' }, async () => {
    const response = await ask(CHAT);

    assertEquals(response.status, 502);
    assert(!(await response.text()).includes('stack trace'));
  });
});

Deno.test('a deployment with no key configured says so without trying', async () => {
  await withWorld({}, async () => {
    Deno.env.delete('GEMINI_API_KEY');

    const response = await ask(CHAT);

    assertEquals(response.status, 503);
    assertEquals(seen.upstream, null);
  });
});

// ---------------------------------------------------------------------------
// Method handling
// ---------------------------------------------------------------------------

/**
 * The cheapest abuse is a flood of requests that never reach Gemini. They cost
 * nothing upstream, but an unmetered path is the one that gets found.
 */
Deno.test('a refused request still counts against the caller', async () => {
  await withWorld({}, async () => {
    const response = await ask({ ...CHAT, model: 'not-allowed' });

    assertEquals(response.status, 400);
    assertEquals(seen.upstream, null);
    assertEquals(seen.inserted.length, 1);
    assertEquals(seen.inserted[0].user_id, 'user-real');
  });
});

Deno.test('an over-limit caller is refused before the body is even read', async () => {
  await withWorld({ countsInWindow: [9999, 9999] }, async () => {
    const response = await ask({ messages: [{ role: 'user', content: 'x'.repeat(100000) }] });

    // 429, not 413: the allowance is checked before the size, so somebody who
    // is already over cannot make us read a large body to find out.
    assertEquals(response.status, 429);
  });
});

Deno.test('preflight is answered, other methods are not', async () => {
  await withWorld({}, async () => {
    const preflight = await handler(
      new Request('https://project.supabase.co/functions/v1/ai-proxy', { method: 'OPTIONS' }),
    );
    assertEquals(preflight.status, 204);

    const get = await handler(
      new Request('https://project.supabase.co/functions/v1/ai-proxy', { method: 'GET' }),
    );
    assertEquals(get.status, 405);
  });
});

Deno.test('usage is recorded with sizes, never with content', async () => {
  await withWorld({}, async () => {
    await ask({ messages: [{ role: 'user', content: 'a very secret prompt' }] });

    const row = seen.inserted[0];
    assertEquals(row.user_id, 'user-real');
    assertEquals(row.model, 'gemini-2.5-flash');
    assert((row.request_bytes as number) > 0);
    assert((row.response_bytes as number) > 0);
    assert(!JSON.stringify(row).includes('a very secret prompt'));
    assert(!JSON.stringify(row).includes('وعليكم السلام'));
  });
});

// ---------------------------------------------------------------------------
// Streaming
//
// The whole point is that the bytes are forwarded rather than collected, so
// these check what crosses the boundary and — more importantly — that a
// streamed call is still metered. Counting rows is what the allowance does, so
// a stream that were recorded only on completion would make hanging up
// mid-answer the cheapest way to use this function for nothing.
// ---------------------------------------------------------------------------

const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
const STREAMING = {
  upstreamBody: SSE,
  upstreamHeaders: { 'content-type': 'text/event-stream' },
};

Deno.test('a streamed reply is forwarded as an event stream', async () => {
  await withWorld(STREAMING, async () => {
    const response = await ask({ ...CHAT, stream: true });

    assertEquals(response.status, 200);
    assertEquals(response.headers.get('content-type'), 'text/event-stream');
    assertEquals(await response.text(), SSE);
  });
});

Deno.test('a streamed call is recorded before any token is forwarded', async () => {
  await withWorld(STREAMING, async () => {
    await ask({ ...CHAT, stream: true });

    assertEquals(seen.inserted.length, 1);
    assertEquals(seen.inserted[0].upstream_status, 200);
    assertEquals(typeof seen.inserted[0].request_bytes, 'number');
  });
});

Deno.test('a streamed call counts against the allowance like any other', async () => {
  Deno.env.set('AI_RATE_LIMIT_PER_MINUTE', '1');
  await withWorld({ ...STREAMING, countsInWindow: [1, 1] }, async () => {
    const response = await ask({ ...CHAT, stream: true });
    assertEquals(response.status, 429);
    // Refused before Gemini was ever reached.
    assertEquals(seen.upstream, null);
  });
});

/** A provider that ignores `stream` is answered as the whole body it sent. */
Deno.test('a whole-body reply to a stream request is still passed through', async () => {
  await withWorld({}, async () => {
    const response = await ask({ ...CHAT, stream: true });

    assertEquals(response.headers.get('content-type'), 'application/json');
    const body = await response.json();
    assertEquals(body.choices[0].message.content, 'وعليكم السلام');
  });
});

Deno.test('a streamed reply never carries the key', async () => {
  await withWorld(STREAMING, async () => {
    const response = await ask({ ...CHAT, stream: true });
    const text = await response.text();

    if (text.includes(SECRET)) throw new Error('the key reached the client');
    for (const [, value] of response.headers) {
      if (String(value).includes(SECRET)) throw new Error('the key is in a response header');
    }
  });
});
