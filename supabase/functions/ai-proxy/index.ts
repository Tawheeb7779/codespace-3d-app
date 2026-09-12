/**
 * The only path from a TA CODE browser session to Gemini.
 *
 * The deployment holds one Gemini key for every user, which changes what the
 * boundary has to do. The GitHub proxy protects a credential that belongs to
 * the caller; this one protects a credential that belongs to *us*, and the
 * caller is the threat model. Four checks stand between a request and Google:
 *
 *  1. The Supabase JWT must resolve to a real user. The id comes from the
 *     verified token and from nowhere else — a `userId` in the body is ignored,
 *     so rate limits cannot be shed by claiming to be somebody new.
 *  2. The request must be within the size budget, read from a length-capped
 *     body so an oversized one is refused before it is parsed rather than
 *     after.
 *  3. The caller must be under their per-minute and per-day allowance, counted
 *     in Postgres against the id from step 1.
 *  4. The model must be one this deployment allows, and the reply is capped, so
 *     a prompt cannot ask for an unbounded — and unboundedly billed — answer.
 *
 * The key is read from the environment, attached to one outbound request, and
 * dropped. It is never returned, never logged, never put in a URL, and never
 * echoed in an error: upstream failures are re-shaped here, so a provider that
 * quotes the request back cannot relay it to the browser.
 *
 * Streams when the caller asks for it. That was not always true: the client
 * was request/response, so this was too, and the note here used to say a
 * streaming proxy would have nothing to stream into. `complete()` grew a real
 * streaming path, and a hosted user was the one person who could not have it —
 * the allowlist quietly dropped `stream`, Google returned a whole body, and
 * the client parsed it as one. Correct, and the slowest possible version of a
 * feature everyone else had.
 *
 * Metering is unchanged by it, because the allowance counts rows rather than
 * bytes: the row is written as soon as Google accepts the request, before a
 * single token is forwarded, so a stream cannot be a way to make an unmetered
 * call. The reply is still bounded by `AI_MAX_OUTPUT_TOKENS`.
 */

import { CORS_HEADERS, HttpError, envInt, fail, json } from '../_shared/http.ts';
import { countRows, insertRow, verifyUser } from '../_shared/rest.ts';

/**
 * Google's OpenAI-compatible surface.
 *
 * The `/openai` segment is load-bearing: the native REST API under `/v1beta`
 * authenticates by `x-goog-api-key` and would ignore the bearer token sent
 * here, leaving the request with no identity at all.
 */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Limits, all overridable so an operator can tune them without a code change.
 *
 * The per-minute default is not a guess. One assistant turn is a loop of up to
 * `MAX_STEPS` provider calls — twelve, in `src/lib/ai/agent.ts` — fired back to
 * back as the agent reads files and runs a build. A limit below that would cut
 * a single ordinary request in half, so the floor is "several full agent turns
 * a minute", not "several messages a minute".
 */
const limits = () => ({
  perMinute: envInt('AI_RATE_LIMIT_PER_MINUTE', 60),
  perDay: envInt('AI_RATE_LIMIT_PER_DAY', 1500),
  maxRequestBytes: envInt('AI_MAX_REQUEST_BYTES', 512 * 1024),
  maxOutputTokens: envInt('AI_MAX_OUTPUT_TOKENS', 4096),
  maxMessages: envInt('AI_MAX_MESSAGES', 200),
});

/** Which models this deployment will pay for. Empty means "the default only". */
function allowedModels(): string[] {
  const raw = Deno.env.get('GEMINI_ALLOWED_MODELS')?.trim();
  const configured = Deno.env.get('GEMINI_MODEL')?.trim() || DEFAULT_MODEL;
  if (!raw) return [configured];
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length ? list : [configured];
}

function resolveModel(requested: unknown): string {
  const allowed = allowedModels();
  if (typeof requested !== 'string' || !requested.trim()) return allowed[0];
  const wanted = requested.trim();
  if (!allowed.includes(wanted)) {
    throw new HttpError(400, `That model is not available here. Available: ${allowed.join(', ')}.`);
  }
  return wanted;
}

/**
 * Read the body, refusing an oversized one without buffering all of it.
 *
 * `Content-Length` is a hint a client controls, so it is checked first as a
 * cheap rejection and then enforced again while reading — a chunked request
 * that lies about its length still stops at the cap.
 */
async function readBounded(request: Request, cap: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) {
    throw new HttpError(413, 'That request is too large. Reduce the context you are sending.');
  }
  const body = request.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new HttpError(413, 'That request is too large. Reduce the context you are sending.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * How many requests this user has made since `since`.
 *
 * Counted, never listed: the ledger holds one row per request and only the
 * total is needed, so this costs one index scan rather than a transfer of the
 * window.
 */
function countSince(userId: string, since: Date): Promise<number> {
  return countRows('ai_requests', {
    user_id: `eq.${userId}`,
    created_at: `gte.${since.toISOString()}`,
  });
}

/**
 * Refuse a caller who is over either allowance.
 *
 * Fixed windows, not a sliding average: the point is a ceiling an operator can
 * reason about and a user can wait out, and `retry-after` says how long.
 */
async function enforceRateLimit(userId: string): Promise<void> {
  const { perMinute, perDay } = limits();
  const now = Date.now();

  const lastMinute = await countSince(userId, new Date(now - 60_000));
  if (lastMinute >= perMinute) {
    throw new RateLimited('You are sending requests faster than the assistant allows.', 60);
  }
  const lastDay = await countSince(userId, new Date(now - 86_400_000));
  if (lastDay >= perDay) {
    throw new RateLimited("You have reached today's assistant limit.", 3600);
  }
}

class RateLimited extends HttpError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(429, message);
    this.name = 'RateLimited';
  }
}

/** Record what was spent. Never the prompt or the reply — only their sizes. */
async function record(
  userId: string,
  model: string,
  requestBytes: number,
  responseBytes: number,
  upstreamStatus: number,
): Promise<void> {
  const ok = await insertRow('ai_requests', {
    user_id: userId,
    model,
    request_bytes: requestBytes,
    response_bytes: responseBytes,
    upstream_status: upstreamStatus,
  });
  // A ledger write that fails must not fail the user's request, but it must be
  // visible: an unrecorded request is an unmetered one.
  if (!ok) console.error('ai-proxy: usage not recorded');
}

interface ChatBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  stream?: unknown;
}

/**
 * Rebuild the upstream request from scratch.
 *
 * Forwarding the caller's object would let it set anything the API accepts —
 * `n`, a candidate count, a sampling budget — and bill us for it. Only these
 * fields cross, and `max_tokens` is ours.
 *
 * `stream` is on the list but is not the caller's value: it is normalised to
 * the literal `true` or left out entirely, so asking to stream cannot be a way
 * to smuggle a different type or a second parameter through.
 */
function upstreamBody(body: ChatBody, model: string, maxOutputTokens: number): unknown {
  const { messages, tools, tool_choice, temperature, stream } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'A request needs at least one message.');
  }
  if (messages.length > limits().maxMessages) {
    throw new HttpError(400, 'That conversation is too long. Start a new one.');
  }
  return {
    model,
    messages,
    max_tokens: maxOutputTokens,
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(tool_choice === undefined ? {} : { tool_choice }),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    // Only ever the literal `true`: the field stays an allowlisted boolean
    // rather than whatever the caller put there.
    ...(stream === true ? { stream: true } : {}),
  };
}

/**
 * An upstream failure, re-shaped.
 *
 * Google's own message is safe and useful — "API key not valid", "model not
 * found" — but it is a message from a system holding our credential, so it is
 * length-capped and only ever passed through for statuses where it describes
 * the *request*. A 401 or 403 from Google means our key is wrong, which is an
 * operator problem and not something to explain to a user.
 */
async function upstreamFailure(response: Response): Promise<Response> {
  const text = await response.text().catch(() => '');

  if (response.status === 401 || response.status === 403 || response.status === 400) {
    let reason = '';
    try {
      const parsed = JSON.parse(text);
      const error = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
      reason = typeof error?.message === 'string' ? error.message : '';
    } catch {
      reason = '';
    }
    const aboutTheKey = /api[ _-]?key|authorization|permission|credential|billing|quota|enable/i;
    if (response.status !== 400 || aboutTheKey.test(reason)) {
      // Operator-facing, and only the shape of the fault — never the key.
      console.error(`ai-proxy: upstream rejected the deployment key (${response.status})`);
      return fail(503, 'The assistant is not configured correctly. Contact the administrator.');
    }
    return fail(400, reason.slice(0, 200) || 'The assistant could not accept that request.');
  }

  if (response.status === 429) {
    console.error('ai-proxy: upstream rate limited the deployment key');
    return json({ message: 'The assistant is busy. Try again shortly.' }, 429, {
      'retry-after': '30',
    });
  }

  console.error(`ai-proxy: upstream error ${response.status}`);
  return fail(502, 'The assistant is unavailable right now. Try again shortly.');
}

export async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return fail(405, 'Use POST.');

  const config = limits();

  let user: { id: string; email: string } | null = null;
  let model = '';
  let requestBytes = 0;

  try {
    // Identity first: everything after it is counted against this id.
    user = await verifyUser(request, 'Sign in to use the assistant.');

    // And the allowance second, before any work at all. Checking it later
    // would leave a caller who is already over their limit able to make us
    // read, parse and validate a body for every request they send.
    await enforceRateLimit(user.id);

    const raw = await readBounded(request, config.maxRequestBytes);
    requestBytes = new TextEncoder().encode(raw).length;

    let body: ChatBody;
    try {
      body = JSON.parse(raw || '{}') as ChatBody;
    } catch {
      throw new HttpError(400, 'That request was not valid JSON.');
    }

    model = resolveModel(body.model);
    const payload = upstreamBody(body, model, config.maxOutputTokens);

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) {
      console.error('ai-proxy: GEMINI_API_KEY is not set');
      return fail(503, 'The assistant is not configured. Contact the administrator.');
    }

    const upstream = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const failure = await upstreamFailure(upstream);
      await record(user.id, model, requestBytes, 0, upstream.status);
      return failure;
    }

    /*
     * A streamed reply is forwarded as it arrives.
     *
     * The ledger row is written first, not after. Counting rows is what the
     * allowance does, so recording before the body is forwarded means a call
     * is metered even if the caller disconnects halfway — the alternative
     * makes hanging up mid-stream the cheapest way to use this function for
     * free.
     */
    const streamed =
      (upstream.headers.get('content-type') ?? '').toLowerCase().includes('event-stream') &&
      upstream.body !== null;

    if (streamed) {
      await record(user.id, model, requestBytes, 0, upstream.status);
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          ...CORS_HEADERS,
        },
      });
    }

    const text = await upstream.text();
    await record(user.id, model, requestBytes, new TextEncoder().encode(text).length, upstream.status);
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS },
    });
  } catch (error) {
    if (error instanceof RateLimited) {
      return json({ message: error.message }, 429, {
        'retry-after': String(error.retryAfterSeconds),
      });
    }
    if (error instanceof HttpError) {
      // A request we refused still counts against the caller. Otherwise the
      // cheapest way to make this function work forever is to send it things
      // it will reject: those never reach Gemini, but they are not free, and
      // an unmetered path is the one an abuser finds.
      if (user) await record(user.id, model || 'refused', requestBytes, 0, error.status);
      return fail(error.status, error.message);
    }
    // Never surface an internal message: it could carry request details, and a
    // stack from this function is a description of where the key lives.
    console.error('ai-proxy failure', error instanceof Error ? error.name : 'unknown');
    return fail(500, 'The assistant failed. Try again.');
  }
}

// Exported above and served here, so a test drives the same function the
// deployment does rather than a description of it.
if (!Deno.env.get('AI_PROXY_TEST')) Deno.serve(handler);
