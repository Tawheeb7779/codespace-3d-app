import { readSse } from '@/lib/ai/sse';
import type { ToolDefinition } from '@/lib/ai/tools';

/**
 * LLM transport for the coding agent.
 *
 * Credentials never touch localStorage or the project database. The key lives
 * in sessionStorage for the life of the tab only, and the panel says so. If no
 * provider is configured the agent refuses to run rather than inventing an
 * answer.
 *
 * Three shapes are supported:
 *  - `anthropic`: the Messages API, called directly from the browser. This
 *    requires the account to allow direct browser access.
 *  - `openai`: any OpenAI-compatible `/chat/completions` endpoint, including a
 *    self-hosted proxy — the recommended setup, because the key can then stay
 *    on your own server.
 *  - `gemini`: Google's own OpenAI-compatible surface for the Gemini models. It
 *    is the `openai` transport with a base URL filled in, not a second client:
 *    Google speaks `POST /chat/completions` with a bearer token there, which is
 *    exactly what {@link callOpenAi} already sends.
 *
 * There is no fourth shape where TA CODE holds the key. The app is a static
 * site with no server of its own, so a key it "kept" would be a key it shipped
 * to every visitor.
 *
 * Each shape can answer all at once or a piece at a time. Passing a
 * {@link StreamHandler} to {@link complete} asks for the provider's own
 * streaming protocol — server-sent events, `stream: true` — and the text is
 * handed over as it is produced. Omitting it makes exactly the single-response
 * call this file has always made. Nothing here fabricates the difference: text
 * is never chopped up after the fact to look progressive, and a provider or
 * model that will not stream falls back to one whole answer.
 */

export type ProviderKind = 'none' | 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  /** Base URL for OpenAI-compatible providers. */
  baseUrl: string;
  /**
   * What the provider said about this model's streaming support.
   *
   * `true` and `false` are the provider's own answer, read from its model list
   * by {@link discoverModels} and recorded when the model is chosen. Absent or
   * `null` means it did not say — which is not the same as "no", so a stream is
   * still attempted and falls back to one whole answer if the provider refuses
   * the request. Only an explicit `false` skips streaming outright.
   */
  streaming?: boolean | null;
}

/**
 * Google's OpenAI-compatible endpoint.
 *
 * The `/openai` segment is load-bearing. Without it the same host serves the
 * native Gemini REST API, which authenticates by `x-goog-api-key` or a `key`
 * query parameter and ignores the `Authorization` header this transport sends —
 * so the request arrives with no identity at all and Google answers
 * `403 PERMISSION_DENIED: Method doesn't allow unregistered callers`.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Prefilled, not pinned: the field stays editable because Google's model names
 * turn over faster than this file does.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_PROVIDER: ProviderConfig = {
  kind: 'none',
  model: 'claude-sonnet-5',
  baseUrl: '',
};

/**
 * A completion endpoint that holds its own credential.
 *
 * The hosted assistant: TA CODE's Edge Function owns the Gemini key, and what
 * the browser sends is its Supabase session — proof of who is asking, not
 * permission to spend. Shaped as data rather than a second transport because
 * the request on the wire is the same OpenAI chat-completions call, so
 * {@link callOpenAi} sends it and parses the reply either way.
 */
export interface HostedEndpoint {
  /** The full URL to POST to; no path is appended. */
  url: string;
  /** Sent verbatim. Carries a session token, never a provider key. */
  headers: Record<string, string>;
}

/**
 * Resolved per request, not once per turn.
 *
 * An agent turn is up to `MAX_STEPS` calls over minutes, and a Supabase access
 * token can expire inside one. Asking again each time gets a refreshed token
 * instead of failing the eleventh step with a 401.
 */
export type HostedResolver = () => Promise<HostedEndpoint | null>;

/**
 * Where a completion is actually sent.
 *
 * Gemini falls back to Google's endpoint so that choosing it is enough; a
 * pasted base URL still wins, which is what a corporate proxy in front of
 * Gemini needs.
 */
export function resolveBaseUrl(config: ProviderConfig): string {
  const configured = config.baseUrl.trim().replace(/\/+$/, '');
  if (config.kind === 'gemini') return configured || GEMINI_BASE_URL;
  return configured;
}

/** What each provider is prefilled with, and therefore what "untouched" means. */
const SUGGESTED_MODEL: Record<ProviderKind, string> = {
  none: DEFAULT_PROVIDER.model,
  anthropic: DEFAULT_PROVIDER.model,
  openai: '',
  gemini: DEFAULT_GEMINI_MODEL,
};

/**
 * The model to carry into a newly chosen provider.
 *
 * Switching provider used to leave the previous provider's model in the field,
 * so choosing Gemini and pressing send asked Google for `claude-sonnet-5`. A
 * model the user typed is theirs and survives the switch; one that is still a
 * suggestion is replaced by the new provider's.
 */
export function modelForKind(kind: ProviderKind, current: string): string {
  const untouched = Object.values(SUGGESTED_MODEL).includes(current.trim());
  return untouched ? SUGGESTED_MODEL[kind] : current;
}

const KEY_STORAGE = 'forge.ai.key';

export function readApiKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function writeApiKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage can be blocked; the key then simply lives in memory for this turn.
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tokens the provider said it used. Never estimated.
 *
 * Each side is independently nullable because providers report them
 * independently: Anthropic sends the input count when the message opens and
 * the output count when it closes, so a stream cut short has one and not the
 * other. A count nobody sent stays null rather than becoming a zero, which
 * would read as a fact — "0 tokens" is a measurement, "unknown" is the truth.
 */
export interface CompletionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Provider-native assistant message, appended verbatim to the transcript. */
  raw: unknown;
  /** Present only when the provider reported it. */
  usage?: CompletionUsage | null;
}

/**
 * Where the text goes as it is produced, for a caller that wants it live.
 *
 * Supplying one is what turns a request into a streamed request: without it
 * {@link complete} makes the same single-response call it always has. The text
 * is passed cumulatively rather than as increments, so a caller that simply
 * renders what it is given needs no buffer of its own and cannot end up
 * displaying a response with a fragment missing from the middle.
 */
export interface StreamHandler {
  onText: (textSoFar: string) => void;
}

export type ProviderErrorKind =
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'request';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Unix seconds a rate-limited provider said to retry after, when it said. */
  readonly retryAt: number | null;

  constructor(message: string, kind: ProviderErrorKind = 'request', retryAt: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

/**
 * How long to wait for a completion before giving up.
 *
 * A provider that accepts the connection and then never answers would
 * otherwise leave the task running forever, with no way out but the Stop
 * button. Generous enough for a long tool-using turn, finite by design.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Host only: a full URL could carry a key in a query string. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured endpoint';
  }
}

function timeoutMessage(timeoutMs: number): string {
  return (
    `The provider did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
    'It may be overloaded — try again.'
  );
}

/**
 * A request in flight, with its deadline still armed.
 *
 * The deadline has to be able to outlive the response headers. A streamed
 * response arrives in two parts — headers immediately, body over the following
 * seconds — so disarming the timer when the headers land would leave the body
 * with no deadline at all, and a provider that goes quiet mid-sentence would
 * hold the task open forever. That was the whole failure the timeout exists to
 * prevent, so the same {@link REQUEST_TIMEOUT_MS} covers headers and body
 * together and the caller says when there is nothing more to read.
 */
interface ProviderRequest {
  response: Response;
  /** True when the deadline fired, rather than the caller cancelling. */
  expired: () => boolean;
  /** Disarms the deadline. Must be called once the body is read or abandoned. */
  release: () => void;
}

/**
 * The one place a provider request is made, so timeout, cancellation and error
 * shape are identical for every provider.
 *
 * The user's abort and the timeout share one signal downstream, so which of
 * them fired is tracked here: a cancelled task must read as cancelled, never
 * as a provider failure.
 */
async function providerRequest(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ProviderRequest> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = () => controller.abort();
  signal.addEventListener('abort', relay);
  const release = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  };

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, expired: () => timedOut, release };
  } catch {
    release();
    if (timedOut) throw new ProviderError(timeoutMessage(timeoutMs), 'timeout');
    // The user's cancellation propagates untouched.
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ProviderError(
      `Could not reach the model provider at ${safeHost(url)}. Check the base URL and your network.`,
      'network',
    );
  }
}

/** A whole-response request: nothing is read after the promise settles. */
async function providerFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const attempt = await providerRequest(url, init, signal, timeoutMs);
  attempt.release();
  return attempt.response;
}

/**
 * A rejected key that does not arrive as 401 or 403.
 *
 * Google answers a bad or absent bearer token on its OpenAI-compatible surface
 * with `400 INVALID_ARGUMENT` and a message naming the key — "API key not
 * valid", "Please pass a valid API key", "Missing or invalid Authorization
 * header". Reported as a bare 400 that reads as a malformed request, and sends
 * someone to look at their prompt instead of their key.
 *
 * Deliberately narrow: a 400 has to name the credential to be read as one, so
 * a genuinely malformed request still surfaces as the request error it is.
 */
const KEY_REJECTED = /\b(api[ _-]?key|authorization header|credential)\b/i;

/**
 * The provider's own one-line reason for refusing a key.
 *
 * "Rejected the API key" is the same sentence whether the key is mistyped, the
 * Generative Language API is switched off for the project, or the key is
 * restricted to referrers this origin is not one of — three different things to
 * go and fix, and Google names which in the body. The reason is a message, not
 * a credential: the key is only ever sent in a header, never echoed in these
 * responses. Capped and stripped of newlines so a provider that answers with a
 * page cannot fill the panel.
 */
function refusalReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    const error = Array.isArray(parsed) ? (parsed[0] as typeof parsed)?.error : parsed?.error;
    const message = error?.message?.trim();
    if (!message) return '';
    const status = error?.status ? ` (${error.status})` : '';
    return `${message.replace(/\s+/g, ' ').slice(0, 180)}${status}`;
  } catch {
    return '';
  }
}

/** Turn a non-2xx response into a typed error, without echoing the request. */
async function providerFailure(response: Response, label: string): Promise<ProviderError> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 400) || response.statusText;

  const rejectedKey =
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && KEY_REJECTED.test(body));
  if (rejectedKey) {
    const reason = refusalReason(body);
    return new ProviderError(
      `${label} rejected the API key (HTTP ${response.status}). ` +
        `${reason ? `${reason} — c` : 'C'}heck the key in provider settings.`,
      'unauthorized',
    );
  }
  if (response.status === 429) {
    const after = Number(response.headers.get('retry-after'));
    const retryAt =
      Number.isFinite(after) && after > 0 ? Math.floor(Date.now() / 1000) + after : null;
    return new ProviderError(
      `${label} is rate limiting this key.${retryAt ? ` Retry after ${after}s.` : ''}`,
      'rate-limited',
      retryAt,
    );
  }
  if (response.status >= 500) {
    return new ProviderError(
      `${label} is having trouble (HTTP ${response.status}). Try again.`,
      'server',
    );
  }
  return new ProviderError(`${label} returned ${response.status}: ${detail}`, 'request');
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Token counts out of whatever the provider called them.
 *
 * OpenAI-compatible endpoints say `prompt_tokens`/`completion_tokens`;
 * Anthropic says `input_tokens`/`output_tokens`. Returns null when neither side
 * was reported, so "the provider did not say" stays distinguishable from "the
 * provider said zero".
 */
function readUsage(raw: unknown): CompletionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const fields = raw as Record<string, unknown>;
  const inputTokens = finiteOrNull(fields.prompt_tokens ?? fields.input_tokens);
  const outputTokens = finiteOrNull(fields.completion_tokens ?? fields.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

/**
 * Merge what a later part of a stream reported over what an earlier part did.
 *
 * Anthropic sends the input count in `message_start` and the output count in
 * `message_delta`, so neither event alone is the answer and a plain replacement
 * would discard half of it.
 */
function mergeUsage(
  current: CompletionUsage | null,
  next: CompletionUsage | null,
): CompletionUsage | null {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
  };
}

/** A provider's own message, fit for one line of a panel. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

/** Parse a body that is supposed to be JSON, and say so plainly when it is not. */
async function providerJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A proxy answering with HTML, or a base URL that is not an API at all.
    throw new ProviderError(
      `${label} returned a non-JSON response. Is the base URL pointing at the API?`,
      'malformed',
    );
  }
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

const ANTHROPIC_LABEL = 'The Anthropic API';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/**
 * One request shape for both the whole-response and streamed calls.
 *
 * Built once rather than twice because a difference between them would be a
 * difference in what the model is asked — different tools, a different system
 * prompt — appearing only in whichever path a given model happened to take.
 */
function anthropicInit(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(stream ? { accept: 'text/event-stream' } : {}),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system,
      messages,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
      ...(stream ? { stream: true } : {}),
    }),
  };
}

/** Content blocks to a result, whether they arrived whole or in pieces. */
function anthropicResult(
  content: AnthropicBlock[],
  stopReason: string | undefined,
  usage: CompletionUsage | null,
): CompletionResult {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const toolCalls = content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id ?? '',
      name: block.name ?? '',
      input: block.input ?? {},
    }));
  return { text, toolCalls, stopReason: stopReason ?? 'stop', raw: content, usage };
}

async function callAnthropic(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<CompletionResult> {
  const response = await providerFetch(
    ANTHROPIC_URL,
    anthropicInit(config, apiKey, system, messages, tools, false),
    signal,
  );

  if (!response.ok) throw await providerFailure(response, ANTHROPIC_LABEL);

  const data = (await providerJson(response, ANTHROPIC_LABEL)) as {
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: unknown;
  };
  if (!Array.isArray(data.content)) {
    throw new ProviderError(
      `${ANTHROPIC_LABEL} returned a response with no content block.`,
      'malformed',
    );
  }
  return anthropicResult(data.content, data.stop_reason, readUsage(data.usage));
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAiCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: unknown;
}

/**
 * Where an OpenAI-compatible completion is sent.
 *
 * Hosted names its own URL and carries its own headers; the key argument is
 * not consulted at all, so a stale one cannot leak into a hosted request.
 */
function openAiUrl(config: ProviderConfig, hosted: HostedEndpoint | null): string {
  if (hosted) return hosted.url;
  const base = resolveBaseUrl(config);
  if (!base) {
    throw new ProviderError('Set a base URL for the OpenAI-compatible provider.', 'not-configured');
  }
  return `${base}/chat/completions`;
}

/** One request shape for both the whole-response and streamed calls. */
function openAiInit(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  hosted: HostedEndpoint | null,
  stream: boolean,
): RequestInit {
  return {
    method: 'POST',
    headers: hosted
      ? {
          'content-type': 'application/json',
          ...(stream ? { accept: 'text/event-stream' } : {}),
          ...hosted.headers,
        }
      : {
          'content-type': 'application/json',
          ...(stream ? { accept: 'text/event-stream' } : {}),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      ...(stream ? { stream: true } : {}),
    }),
  };
}

/** The model's arguments, parsed, blaming the model rather than the transport. */
function parseToolArguments(args: string, name: string): Record<string, unknown> {
  try {
    return JSON.parse(args || '{}') as Record<string, unknown>;
  } catch {
    // The model, not the transport, produced this — name the tool.
    throw new ProviderError(
      `The model produced invalid JSON arguments for ${name}.`,
      'malformed',
    );
  }
}

/**
 * A whole chat completion to a result.
 *
 * Shared with the streaming path, which lands here whenever a provider accepts
 * `stream: true` and answers with one complete body anyway.
 */
function parseOpenAiCompletion(data: OpenAiCompletion, label: string): CompletionResult {
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new ProviderError(`${label} returned no message in its response.`, 'malformed');
  }

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
    if (!call?.function?.name) {
      throw new ProviderError(`${label} returned a tool call with no name.`, 'malformed');
    }
    return {
      id: call.id ?? '',
      name: call.function.name,
      input: parseToolArguments(call.function.arguments, call.function.name),
    };
  });

  return {
    text: choice.message.content ?? '',
    toolCalls,
    stopReason: choice.finish_reason ?? 'stop',
    raw: choice.message,
    usage: readUsage(data.usage),
  };
}

async function callOpenAi(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  label = 'The provider',
  hosted: HostedEndpoint | null = null,
): Promise<CompletionResult> {
  const response = await providerFetch(
    openAiUrl(config, hosted),
    openAiInit(config, apiKey, system, messages, tools, hosted, false),
    signal,
  );

  if (!response.ok) throw await providerFailure(response, label);

  return parseOpenAiCompletion((await providerJson(response, label)) as OpenAiCompletion, label);
}

/**
 * Whether a 200 is actually a stream.
 *
 * Only `text/event-stream`, or no content type at all — the one realistic way
 * a real stream arrives unlabelled is a proxy that strips the header. Anything
 * else is read as a whole body, and that asymmetry is deliberate, because the
 * two mistakes are not equally bad.
 *
 * Reading a buffered answer as a stream finds no frames and reports the
 * provider as having stopped mid-sentence — a hard failure on a response that
 * was complete and correct, which is exactly what a gateway returning JSON
 * under `text/plain` produced. Reading a stream as a whole body just buffers
 * it: the answer is still right, it simply is not progressive. So the doubtful
 * case degrades instead of failing.
 */
function isStreamedResponse(response: Response): boolean {
  const contentType = (response.headers.get('content-type') ?? '').trim().toLowerCase();
  return !contentType || contentType.includes('event-stream');
}

/**
 * What to raise when reading a stream's body fails.
 *
 * Order matters. A malformed frame is the transport's own diagnosis and stands.
 * Otherwise the read failed because something aborted the request, and which
 * something it was decides what the user is told: their own Stop button must
 * never surface as a provider fault, and the deadline must never surface as a
 * cancellation they did not make.
 */
function streamFailure(
  error: unknown,
  attempt: ProviderRequest,
  signal: AbortSignal,
  label: string,
): unknown {
  if (error instanceof ProviderError) return error;
  if (attempt.expired()) return new ProviderError(timeoutMessage(REQUEST_TIMEOUT_MS), 'timeout');
  if (signal.aborted) return new DOMException('Aborted', 'AbortError');
  return new ProviderError(
    `${label} dropped the connection while answering. Nothing more arrived.`,
    'network',
  );
}

/** A `data:` line to an object, blaming the provider for anything else. */
function streamPayload(data: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError(
      `${label} sent a streamed chunk that was not valid JSON.`,
      'malformed',
    );
  }
}

/**
 * A failure a provider reported inside an otherwise successful stream.
 *
 * The HTTP status was 200 — the provider had already committed to answering
 * when whatever went wrong went wrong. Reported as a server problem because
 * that is what it almost always is upstream of a gateway, and because "try
 * again" is the correct advice for it.
 */
function streamedError(payload: Record<string, unknown>, label: string): ProviderError | null {
  const raw = payload.error;
  if (!raw) return null;
  const detail =
    typeof raw === 'string'
      ? oneLine(raw)
      : oneLine(String((raw as { message?: unknown }).message ?? ''));
  const type = oneLine(String((raw as { type?: unknown }).type ?? ''));
  if (/rate.?limit/i.test(`${type} ${detail}`)) {
    return new ProviderError(`${label} is rate limiting this key. ${detail}`.trim(), 'rate-limited');
  }
  if (/auth|api.?key|credential/i.test(`${type} ${detail}`)) {
    return new ProviderError(
      `${label} rejected the API key. ${detail || 'Check the key in provider settings.'}`.trim(),
      'unauthorized',
    );
  }
  return new ProviderError(
    `${label} failed partway through its answer${detail ? `: ${detail}` : '.'}`,
    'server',
  );
}

interface OpenAiToolDraft {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAiStreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * A tool call assembled from the pieces it arrives in.
 *
 * Only the arguments are concatenated. The id and the name are sent once, in
 * the delta that opens the call, and appending them instead would turn a
 * repeated name into `read_fileread_file` — a tool the agent does not have.
 */
function mergeToolDelta(
  drafts: Map<number, OpenAiToolDraft>,
  delta: NonNullable<OpenAiStreamDelta['tool_calls']>[number],
): void {
  const index = typeof delta.index === 'number' ? delta.index : 0;
  const draft = drafts.get(index) ?? { id: '', name: '', arguments: '' };
  if (delta.id) draft.id = delta.id;
  if (delta.function?.name && !draft.name) draft.name = delta.function.name;
  if (delta.function?.arguments) draft.arguments += delta.function.arguments;
  drafts.set(index, draft);
}

async function readOpenAiStream(
  attempt: ProviderRequest,
  signal: AbortSignal,
  label: string,
  stream: StreamHandler,
): Promise<CompletionResult> {
  const body = attempt.response.body;
  if (!body) {
    attempt.release();
    throw new ProviderError(`${label} answered a streaming request with no body.`, 'malformed');
  }

  let text = '';
  let stopReason: string | null = null;
  let usage: CompletionUsage | null = null;
  let terminated = false;
  const drafts = new Map<number, OpenAiToolDraft>();

  try {
    for await (const frame of readSse(body)) {
      // The sentinel that ends an OpenAI-compatible stream. It is not JSON, so
      // it has to be caught before anything tries to parse it.
      if (frame.data === '[DONE]') {
        terminated = true;
        break;
      }
      if (!frame.data) continue;

      const payload = streamPayload(frame.data, label);
      const failure = streamedError(payload, label);
      if (failure) throw failure;

      usage = mergeUsage(usage, readUsage(payload.usage));

      const choice = (payload.choices as Array<{ delta?: OpenAiStreamDelta; finish_reason?: string | null }>)?.[0];
      if (!choice) continue;
      // Noted, not broken on: the usage chunk generally comes after this one,
      // and a stream that stopped here has still finished properly.
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        terminated = true;
      }
      const delta = choice.delta;
      if (!delta) continue;
      // An empty delta is a real and frequent chunk. It is not an error and it
      // is not content, so nothing is reported for it.
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        stream.onText(text);
      }
      for (const call of delta.tool_calls ?? []) mergeToolDelta(drafts, call);
    }
  } catch (error) {
    throw streamFailure(error, attempt, signal, label);
  } finally {
    attempt.release();
  }

  if (!terminated) {
    // Neither `[DONE]` nor a finish reason arrived, so the provider stopped
    // mid-answer. Reported rather than returned: a truncated response handed
    // back as a complete one is the agent acting on half an instruction.
    throw new ProviderError(
      `${label} ended its response before finishing. Try again.`,
      'malformed',
    );
  }

  const calls = [...drafts.entries()].sort(([a], [b]) => a - b).map(([, draft]) => draft);
  const toolCalls: ToolCall[] = calls.map((draft) => {
    if (!draft.name) {
      throw new ProviderError(`${label} returned a tool call with no name.`, 'malformed');
    }
    return {
      id: draft.id,
      name: draft.name,
      input: parseToolArguments(draft.arguments, draft.name),
    };
  });

  return {
    text,
    toolCalls,
    stopReason: stopReason ?? 'stop',
    // Rebuilt in the provider's own message shape, because this goes back to
    // the provider as transcript on the next step.
    raw: {
      role: 'assistant',
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((draft) => ({
              id: draft.id,
              type: 'function',
              function: { name: draft.name, arguments: draft.arguments },
            })),
          }
        : {}),
    },
    usage,
  };
}

async function streamOpenAi(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  label: string,
  hosted: HostedEndpoint | null,
  stream: StreamHandler,
): Promise<CompletionResult> {
  const attempt = await providerRequest(
    openAiUrl(config, hosted),
    openAiInit(config, apiKey, system, messages, tools, hosted, true),
    signal,
  );

  if (!attempt.response.ok) {
    attempt.release();
    throw await providerFailure(attempt.response, label);
  }
  // A provider may accept `stream: true` and answer with one whole body
  // regardless — a proxy that does not implement streaming, or a gateway that
  // buffers. The answer in hand is still the answer, so it is read with the
  // same parser rather than failed or requested a second time.
  if (!isStreamedResponse(attempt.response)) {
    attempt.release();
    return parseOpenAiCompletion(
      (await providerJson(attempt.response, label)) as OpenAiCompletion,
      label,
    );
  }

  return readOpenAiStream(attempt, signal, label, stream);
}

interface AnthropicBlockDraft {
  type: string;
  text: string;
  id: string;
  name: string;
  partialJson: string;
}

async function readAnthropicStream(
  attempt: ProviderRequest,
  signal: AbortSignal,
  stream: StreamHandler,
): Promise<CompletionResult> {
  const label = ANTHROPIC_LABEL;
  const body = attempt.response.body;
  if (!body) {
    attempt.release();
    throw new ProviderError(`${label} answered a streaming request with no body.`, 'malformed');
  }

  let text = '';
  let stopReason: string | undefined;
  let usage: CompletionUsage | null = null;
  let terminated = false;
  const blocks = new Map<number, AnthropicBlockDraft>();

  try {
    for await (const frame of readSse(body)) {
      // Sent purely to hold the connection open during a long generation.
      if (frame.event === 'ping' || !frame.data) continue;

      const payload = streamPayload(frame.data, label);
      const failure = streamedError(payload, label);
      if (failure) throw failure;

      const type = frame.event || String(payload.type ?? '');
      const index = finiteOrNull(payload.index) ?? 0;

      if (type === 'message_start') {
        const message = payload.message as { usage?: unknown } | undefined;
        usage = mergeUsage(usage, readUsage(message?.usage));
        continue;
      }
      if (type === 'content_block_start') {
        const block = (payload.content_block ?? {}) as AnthropicBlock;
        blocks.set(index, {
          type: block.type ?? 'text',
          text: block.text ?? '',
          id: block.id ?? '',
          name: block.name ?? '',
          partialJson: '',
        });
        continue;
      }
      if (type === 'content_block_delta') {
        const delta = (payload.delta ?? {}) as {
          type?: string;
          text?: string;
          partial_json?: string;
        };
        const draft =
          blocks.get(index) ??
          { type: delta.partial_json !== undefined ? 'tool_use' : 'text', text: '', id: '', name: '', partialJson: '' };
        if (typeof delta.text === 'string' && delta.text) {
          draft.text += delta.text;
          text += delta.text;
          stream.onText(text);
        }
        if (typeof delta.partial_json === 'string') draft.partialJson += delta.partial_json;
        blocks.set(index, draft);
        continue;
      }
      if (type === 'message_delta') {
        const delta = (payload.delta ?? {}) as { stop_reason?: string };
        if (delta.stop_reason) stopReason = delta.stop_reason;
        usage = mergeUsage(usage, readUsage(payload.usage));
        continue;
      }
      if (type === 'message_stop') {
        terminated = true;
        break;
      }
    }
  } catch (error) {
    throw streamFailure(error, attempt, signal, label);
  } finally {
    attempt.release();
  }

  if (!terminated) {
    throw new ProviderError(
      `${label} ended its response before finishing. Try again.`,
      'malformed',
    );
  }

  // Back into the block array the non-streaming path returns, so the
  // transcript the next step sends is identical either way.
  const content: AnthropicBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, draft]) =>
      draft.type === 'tool_use'
        ? {
            type: 'tool_use',
            id: draft.id,
            name: draft.name,
            input: parseToolArguments(draft.partialJson, draft.name || 'a tool call'),
          }
        : { type: draft.type, text: draft.text },
    );

  return anthropicResult(content, stopReason, usage);
}

async function streamAnthropic(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  stream: StreamHandler,
): Promise<CompletionResult> {
  const attempt = await providerRequest(
    ANTHROPIC_URL,
    anthropicInit(config, apiKey, system, messages, tools, true),
    signal,
  );

  if (!attempt.response.ok) {
    attempt.release();
    throw await providerFailure(attempt.response, ANTHROPIC_LABEL);
  }
  if (!isStreamedResponse(attempt.response)) {
    attempt.release();
    const data = (await providerJson(attempt.response, ANTHROPIC_LABEL)) as {
      content?: AnthropicBlock[];
      stop_reason?: string;
      usage?: unknown;
    };
    if (!Array.isArray(data.content)) {
      throw new ProviderError(
        `${ANTHROPIC_LABEL} returned a response with no content block.`,
        'malformed',
      );
    }
    return anthropicResult(data.content, data.stop_reason, readUsage(data.usage));
  }

  return readAnthropicStream(attempt, signal, stream);
}

/**
 * Endpoints that refused a streamed request, so the next step does not ask
 * again.
 *
 * An agent turn is up to {@link MAX_STEPS} model calls. Without this, a proxy
 * that rejects `stream: true` would be asked twelve times and pay for a
 * discarded request each time — the fallback would work, and cost double.
 */
const NO_STREAMING = new Set<string>();

function streamKey(config: ProviderConfig): string {
  return `${config.kind}|${resolveBaseUrl(config)}|${config.model}`;
}

/** Forget what endpoints refused, so a fixed proxy is tried again. */
export function forgetStreamingRefusals(): void {
  NO_STREAMING.clear();
}

/**
 * Stream when the model can, and fall back to one whole answer when it cannot.
 *
 * Three cases, in order. A model the provider said cannot stream is not asked
 * to. A provider that refuses the parameter anyway is retried once without it
 * and remembered, so the rest of the turn costs nothing extra. Anything else is
 * raised.
 *
 * Only an outright refusal of the request falls back, and that narrowness is
 * deliberate. Retrying a bad key or a rate limit would fail identically;
 * retrying after text has appeared would show the user the same answer twice;
 * and retrying a broken stream — a chunk that was not JSON, a body that
 * stopped early — bills for a second answer and then reports the *second*
 * call's failure, so a provider streaming malformed frames came back as a
 * complaint about the base URL. A stream that breaks is reported as the stream
 * breaking.
 */
async function withWholeAnswerFallback(
  config: ProviderConfig,
  stream: StreamHandler | null,
  streamed: (handler: StreamHandler) => Promise<CompletionResult>,
  whole: () => Promise<CompletionResult>,
): Promise<CompletionResult> {
  const key = streamKey(config);
  if (!stream || config.streaming === false || NO_STREAMING.has(key)) return whole();

  let shown = false;
  try {
    return await streamed({
      onText: (text) => {
        shown = true;
        stream.onText(text);
      },
    });
  } catch (error) {
    const refused = error instanceof ProviderError && error.kind === 'request';
    if (shown || !refused) throw error;
    NO_STREAMING.add(key);
    return whole();
  }
}

export function complete(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  hosted: HostedEndpoint | null = null,
  stream: StreamHandler | null = null,
): Promise<CompletionResult> {
  if (config.kind === 'anthropic') {
    if (!apiKey) {
      // Rejected, never thrown: the signature promises a promise, and a caller
      // that only attaches `.catch` would otherwise see this one escape.
      return Promise.reject(
        new ProviderError('Add an Anthropic API key to use the assistant.', 'not-configured'),
      );
    }
    return withWholeAnswerFallback(
      config,
      stream,
      (handler) => streamAnthropic(config, apiKey, system, messages, tools, signal, handler),
      () => callAnthropic(config, apiKey, system, messages, tools, signal),
    );
  }
  if (config.kind === 'openai') {
    return withWholeAnswerFallback(
      config,
      stream,
      (handler) =>
        streamOpenAi(config, apiKey, system, messages, tools, signal, 'The provider', null, handler),
      () => callOpenAi(config, apiKey, system, messages, tools, signal),
    );
  }
  if (config.kind === 'gemini') {
    // Hosted: the deployment's key, behind its own sign-in check. The browser
    // has no Gemini credential to be missing, so there is nothing to ask for.
    if (hosted) {
      return withWholeAnswerFallback(
        config,
        stream,
        (handler) =>
          streamOpenAi(config, '', system, messages, tools, signal, 'Gemini', hosted, handler),
        () => callOpenAi(config, '', system, messages, tools, signal, 'Gemini', hosted),
      );
    }
    if (!apiKey) {
      // Local Development Mode, where there is no server to hold a key. Without
      // this, an empty key reaches Google as a bearer-less request and comes
      // back as a 400 about the Authorization header — a transport complaint
      // for what is really "you have not connected anything yet".
      return Promise.reject(
        new ProviderError('Add a Gemini API key to use the assistant.', 'not-configured'),
      );
    }
    return withWholeAnswerFallback(
      config,
      stream,
      (handler) =>
        streamOpenAi(config, apiKey, system, messages, tools, signal, 'Gemini', null, handler),
      () => callOpenAi(config, apiKey, system, messages, tools, signal, 'Gemini'),
    );
  }
  return Promise.reject(
    new ProviderError(
      'No AI provider is connected. Open AI settings to connect one.',
      'not-configured',
    ),
  );
}

/** Shape a tool result the way the active provider expects it. */
export function toolResultMessage(
  kind: ProviderKind,
  callId: string,
  name: string,
  content: string,
  isError: boolean,
): ChatMessage | { role: 'tool'; tool_call_id: string; name: string; content: string } {
  if (kind === 'anthropic') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    };
  }
  return { role: 'tool', tool_call_id: callId, name, content };
}
