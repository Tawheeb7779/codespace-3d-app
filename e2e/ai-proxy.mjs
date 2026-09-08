/**
 * The hosted assistant, over real HTTP, end to end.
 *
 * The unit suites test each half: `supabase/functions/ai-proxy/index.test.ts`
 * drives the handler in-process, and `src/lib/ai/hostedAi.test.ts` stubs fetch
 * to check what the browser sends. This joins them. The real Edge Function runs
 * under Deno as a server; a stand-in Supabase answers the auth and ledger calls;
 * a stand-in Google answers the completion; and the requests are the ones the
 * browser actually makes.
 *
 * What it cannot do is prove Google accepts the deployment's key — that needs
 * the key, and it belongs to the operator, not to a test.
 *
 *   node e2e/ai-proxy.mjs
 *
 * Needs Deno on PATH. Skips with a clear message rather than a failure if it is
 * missing, because the rest of the suite must still be runnable without it.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const SECRET = 'deployment-gemini-key-under-test';
const SUPABASE_PORT = 8899;
const GOOGLE_PORT = 8898;
const PROXY_PORT = 8897;

let passed = 0;
let failed = 0;

const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${(error.message ?? String(error)).split('\n')[0]}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

if (!spawnSync('deno', ['--version']).stdout) {
  console.log('SKIP  deno is not installed; the ai-proxy integration test needs it.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// A stand-in Supabase: verifies one token, counts rows, accepts inserts.
// ---------------------------------------------------------------------------

/** Tokens this fake Supabase will vouch for, and who they belong to. */
const SESSIONS = new Map([
  ['token-amina', { id: 'user-amina', email: 'amina@example.test' }],
  ['token-bilal', { id: 'user-bilal', email: 'bilal@example.test' }],
]);

/** Rows the ledger holds, per user. The proxy's rate limit reads this. */
const ledger = [];
let serviceKeySeen = null;

const supabaseStub = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/auth/v1/user') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    serviceKeySeen = req.headers.apikey ?? null;
    const user = SESSIONS.get(token);
    if (!user) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"msg":"invalid"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(user));
  }

  if (url.pathname === '/rest/v1/ai_requests') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        ledger.push(JSON.parse(body));
        res.writeHead(201).end();
      });
      return undefined;
    }
    // `user_id=eq.<id>` and `created_at=gte.<iso>`, exactly as the proxy sends.
    const userId = (url.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
    const since = Date.parse((url.searchParams.get('created_at') ?? '').replace(/^gte\./, ''));
    const total = ledger.filter(
      (row) => row.user_id === userId && Date.parse(row.at ?? new Date().toISOString()) >= since,
    ).length;
    res.writeHead(200, { 'content-range': `0-0/${total}` });
    return res.end();
  }

  res.writeHead(404).end();
});

// ---------------------------------------------------------------------------
// A stand-in Google: records what it was asked, answers what it is told to.
// ---------------------------------------------------------------------------

let googleSaw = null;
let googleAnswer = {
  status: 200,
  body: JSON.stringify({
    choices: [{ message: { content: 'وعليكم السلام' }, finish_reason: 'stop' }],
  }),
};

const googleStub = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    googleSaw = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
    res.writeHead(googleAnswer.status, { 'content-type': 'application/json' });
    res.end(googleAnswer.body);
  });
});

supabaseStub.listen(SUPABASE_PORT);
googleStub.listen(GOOGLE_PORT);
await Promise.all([once(supabaseStub, 'listening'), once(googleStub, 'listening')]);

// ---------------------------------------------------------------------------
// The real function, served by Deno.
// ---------------------------------------------------------------------------

/**
 * `GEMINI_BASE` is a constant in the function, so the stand-in Google is put in
 * its place by resolving that host to localhost — the same trick the GitHub
 * suite uses. Deno has no hosts override, so the function is served through a
 * tiny wrapper that rewrites the one outbound URL and leaves everything else,
 * including every check under test, untouched.
 */
const wrapper = `
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://generativelanguage.googleapis.com')) {
    return realFetch('http://127.0.0.1:${GOOGLE_PORT}' + new URL(url).pathname, init);
  }
  return realFetch(input, init);
};
const { handler } = await import('./supabase/functions/ai-proxy/index.ts');
Deno.serve({ port: ${PROXY_PORT} }, handler);
`;

const proxy = spawn(
  'deno',
  ['run', '--allow-net', '--allow-env', '--no-check', '-'],
  {
    env: {
      ...process.env,
      AI_PROXY_TEST: '1',
      SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-under-test',
      GEMINI_API_KEY: SECRET,
      AI_RATE_LIMIT_PER_MINUTE: '5',
      AI_RATE_LIMIT_PER_DAY: '1000',
      AI_MAX_REQUEST_BYTES: '2048',
      AI_MAX_OUTPUT_TOKENS: '1234',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
proxy.stdin.end(wrapper);

const proxyLog = [];
proxy.stdout.on('data', (d) => proxyLog.push(String(d)));
proxy.stderr.on('data', (d) => proxyLog.push(String(d)));

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/`, { method: 'OPTIONS' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
};

if (!(await ready())) {
  console.log('FAIL  the ai-proxy did not start');
  console.log(proxyLog.join(''));
  proxy.kill();
  supabaseStub.close();
  googleStub.close();
  process.exit(1);
}

/** Exactly the request the browser's hosted transport makes. */
const askAs = (token, body = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'السلام عليكم' }] }) =>
  fetch(`http://127.0.0.1:${PROXY_PORT}/functions/v1/ai-proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      apikey: 'anon-key-which-is-public-by-design',
    },
    body: JSON.stringify(body),
  });

const reset = () => {
  ledger.length = 0;
  googleSaw = null;
  googleAnswer = {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: 'وعليكم السلام' }, finish_reason: 'stop' }],
    }),
  };
};

try {
  await step('1. a signed-in user gets an answer, and never sends a Gemini key', async () => {
    reset();
    const response = await askAs('token-amina');
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(body.choices[0].message.content === 'وعليكم السلام', 'the reply did not come back');
    assert(googleSaw, 'the request never reached Google');
    assert(
      googleSaw.headers.authorization === `Bearer ${SECRET}`,
      'the deployment key was not the credential Google saw',
    );
  });

  await step('2. the browser never holds the key: it is added server-side only', async () => {
    reset();
    await askAs('token-amina');
    // What the browser sent carried a session token; what Google saw carried
    // the deployment's key. The swap happened inside the function.
    assert(googleSaw.headers.authorization !== 'Bearer token-amina', 'the session leaked upstream');
    assert(!JSON.stringify(googleSaw.body).includes(SECRET), 'the key ended up in the body');
  });

  await step('3. an unauthenticated request is a clean 401, and costs nothing', async () => {
    reset();
    const response = await askAs(null);
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(googleSaw === null, 'an unauthenticated request reached Google');
    assert(ledger.length === 0, 'an unauthenticated request was billed');
    const text = await response.text();
    assert(!text.includes(SECRET), 'the 401 leaked the key');
  });

  await step('4. a token Supabase does not know is a 401', async () => {
    reset();
    const response = await askAs('token-forged');
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(googleSaw === null, 'a forged token reached Google');
  });

  await step('5. usage is filed under the verified user, not a claimed one', async () => {
    reset();
    await askAs('token-amina', {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      userId: 'user-bilal',
      user_id: 'user-bilal',
    });
    assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
    assert(
      ledger[0].user_id === 'user-amina',
      `usage was filed under ${ledger[0].user_id}, not the verified caller`,
    );
  });

  await step('6. the rate limit is per user, and returns 429 with a retry-after', async () => {
    reset();
    // The limit is five a minute for this run.
    for (let i = 0; i < 5; i++) {
      const ok = await askAs('token-amina');
      assert(ok.status === 200, `request ${i + 1} should have been served, got ${ok.status}`);
    }
    const limited = await askAs('token-amina');
    assert(limited.status === 429, `expected 429, got ${limited.status}`);
    assert(limited.headers.get('retry-after'), 'no retry-after on the 429');
    const text = await limited.text();
    assert(!text.includes(SECRET), 'the 429 leaked the key');
  });

  await step('7. one user exhausting their limit does not affect another', async () => {
    // Amina is still over from the previous step; Bilal has spent nothing.
    const amina = await askAs('token-amina');
    assert(amina.status === 429, `amina should still be limited, got ${amina.status}`);
    const bilal = await askAs('token-bilal');
    assert(bilal.status === 200, `bilal should be served, got ${bilal.status}`);
  });

  await step('8. the limit cannot be shed by claiming to be somebody else', async () => {
    // Amina is over her limit. Sending Bilal's id in the body must not help.
    const response = await askAs('token-amina', {
      messages: [{ role: 'user', content: 'hi' }],
      userId: 'user-bilal',
    });
    assert(response.status === 429, `a claimed id shed the rate limit: ${response.status}`);
  });

  await step('9. an oversized request is refused with 413', async () => {
    reset();
    const response = await askAs('token-bilal', {
      messages: [{ role: 'user', content: 'x'.repeat(8000) }],
    });
    assert(response.status === 413, `expected 413, got ${response.status}`);
    assert(googleSaw === null, 'an oversized request reached Google');
  });

  await step('10. the server sets the output cap, whatever the client asks for', async () => {
    reset();
    await askAs('token-bilal', {
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 999999,
      stream: true,
    });
    assert(googleSaw.body.max_tokens === 1234, `the cap was ${googleSaw.body.max_tokens}`);
    assert(googleSaw.body.stream === undefined, 'a client-set stream flag reached Google');
  });

  await step('11. a model outside the allowlist is refused before any spend', async () => {
    reset();
    const response = await askAs('token-bilal', {
      model: 'some-expensive-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(googleSaw === null, 'a disallowed model reached Google');
  });

  await step('12. Google refusing our key is not reported as the user’s problem', async () => {
    reset();
    googleAnswer = {
      status: 403,
      body: JSON.stringify({ error: { message: `API key ${SECRET} is not valid` } }),
    };
    const response = await askAs('token-bilal');
    assert(response.status === 503, `expected 503, got ${response.status}`);
    const text = await response.text();
    assert(!text.includes(SECRET), 'the upstream error relayed the key to the browser');
    assert(!/API key/.test(text), 'the user was told to check a key they do not have');
  });

  await step('13. tool calls survive the round trip, so the agent loop works', async () => {
    reset();
    googleAnswer = {
      status: 200,
      body: JSON.stringify({
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
    };
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }];
    const response = await askAs('token-bilal', {
      messages: [{ role: 'user', content: 'read it' }],
      tools,
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(googleSaw.body.tools?.length === 1, 'the tools never reached Google');
    const body = await response.json();
    assert(body.choices[0].message.tool_calls[0].id === 'c1', 'the tool call did not come back');
  });

  await step('14. the ledger records sizes, never the prompt or the reply', async () => {
    reset();
    await askAs('token-bilal', {
      messages: [{ role: 'user', content: 'a distinctive secret prompt' }],
    });
    const row = ledger.at(-1);
    assert(row, 'nothing was recorded');
    assert(row.request_bytes > 0 && row.response_bytes > 0, 'sizes were not recorded');
    const dump = JSON.stringify(row);
    assert(!dump.includes('a distinctive secret prompt'), 'the prompt was stored');
    assert(!dump.includes('وعليكم السلام'), 'the reply was stored');
  });

  await step('15. the service-role key never leaves the server side', async () => {
    assert(
      serviceKeySeen === 'service-role-under-test',
      'the function did not authenticate to Supabase as the service role',
    );
    const log = proxyLog.join('');
    assert(!log.includes(SECRET), 'the function logged the Gemini key');
    assert(!log.includes('service-role-under-test'), 'the function logged the service-role key');
  });
} finally {
  proxy.kill();
  supabaseStub.close();
  googleStub.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
