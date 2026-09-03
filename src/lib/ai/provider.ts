import type { ToolDefinition } from '@/lib/ai/tools';

/**
 * LLM transport for the coding agent.
 *
 * Credentials never touch localStorage or the project database. The key lives
 * in sessionStorage for the life of the tab only, and the panel says so. If no
 * provider is configured the agent refuses to run rather than inventing an
 * answer.
 *
 * Two shapes are supported:
 *  - `anthropic`: the Messages API, called directly from the browser. This
 *    requires the account to allow direct browser access.
 *  - `openai`: any OpenAI-compatible `/chat/completions` endpoint, including a
 *    self-hosted proxy — the recommended setup, because the key can then stay
 *    on your own server.
 */

export type ProviderKind = 'none' | 'anthropic' | 'openai';

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  /** Base URL for OpenAI-compatible providers. */
  baseUrl: string;
}

export const DEFAULT_PROVIDER: ProviderConfig = {
  kind: 'none',
  model: 'claude-sonnet-5',
  baseUrl: '',
};

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

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Provider-native assistant message, appended verbatim to the transcript. */
  raw: unknown;
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

/**
 * The one place a provider request is made, so timeout, cancellation and error
 * shape are identical for every provider.
 *
 * The user's abort and the timeout share one signal downstream, so which of
 * them fired is tracked here: a cancelled task must read as cancelled, never
 * as a provider failure.
 */
async function providerFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = () => controller.abort();
  signal.addEventListener('abort', relay);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    if (timedOut) {
      throw new ProviderError(
        `The provider did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
          'It may be overloaded — try again.',
        'timeout',
      );
    }
    // The user's cancellation propagates untouched.
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ProviderError(
      `Could not reach the model provider at ${safeHost(url)}. Check the base URL and your network.`,
      'network',
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  }
}

/** Turn a non-2xx response into a typed error, without echoing the request. */
async function providerFailure(response: Response, label: string): Promise<ProviderError> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 400) || response.statusText;

  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      `${label} rejected the API key (HTTP ${response.status}). Check the key in provider settings.`,
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

async function callAnthropic(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<CompletionResult> {
  const response = await providerFetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
      }),
    },
    signal,
  );

  if (!response.ok) throw await providerFailure(response, 'The Anthropic API');

  const data = (await providerJson(response, 'The Anthropic API')) as {
    content?: AnthropicBlock[];
    stop_reason?: string;
  };
  if (!Array.isArray(data.content)) {
    throw new ProviderError(
      'The Anthropic API returned a response with no content block.',
      'malformed',
    );
  }
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const toolCalls = data.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id ?? '',
      name: block.name ?? '',
      input: block.input ?? {},
    }));
  return { text, toolCalls, stopReason: data.stop_reason ?? 'stop', raw: data.content };
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

async function callOpenAi(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<CompletionResult> {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (!base) {
    throw new ProviderError('Set a base URL for the OpenAI-compatible provider.', 'not-configured');
  }
  const response = await providerFetch(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
      }),
    },
    signal,
  );

  if (!response.ok) throw await providerFailure(response, 'The provider');

  const data = (await providerJson(response, 'The provider')) as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
      finish_reason?: string;
    }>;
  };
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new ProviderError('The provider returned no message in its response.', 'malformed');
  }

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
    if (!call?.function?.name) {
      throw new ProviderError('The provider returned a tool call with no name.', 'malformed');
    }
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      // The model, not the transport, produced this — name the tool.
      throw new ProviderError(
        `The model produced invalid JSON arguments for ${call.function.name}.`,
        'malformed',
      );
    }
    return { id: call.id ?? '', name: call.function.name, input };
  });

  return {
    text: choice.message.content ?? '',
    toolCalls,
    stopReason: choice.finish_reason ?? 'stop',
    raw: choice.message,
  };
}

export function complete(
  config: ProviderConfig,
  apiKey: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<CompletionResult> {
  if (config.kind === 'anthropic') {
    if (!apiKey) {
      // Rejected, never thrown: the signature promises a promise, and a caller
      // that only attaches `.catch` would otherwise see this one escape.
      return Promise.reject(
        new ProviderError('Add an Anthropic API key to use the assistant.', 'not-configured'),
      );
    }
    return callAnthropic(config, apiKey, system, messages, tools, signal);
  }
  if (config.kind === 'openai') {
    return callOpenAi(config, apiKey, system, messages, tools, signal);
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
