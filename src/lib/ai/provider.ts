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

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
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
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
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
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new ProviderError(
      `Anthropic API returned ${response.status}: ${detail.slice(0, 400) || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    content: AnthropicBlock[];
    stop_reason: string;
  };
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
  return { text, toolCalls, stopReason: data.stop_reason, raw: data.content };
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
  if (!base) throw new ProviderError('Set a base URL for the OpenAI-compatible provider.');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
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
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new ProviderError(
      `Provider returned ${response.status}: ${detail.slice(0, 400) || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: { content: string | null; tool_calls?: OpenAiToolCall[] };
      finish_reason: string;
    }>;
  };
  const choice = data.choices?.[0];
  if (!choice) throw new ProviderError('Provider returned no choices');

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      throw new ProviderError(`Model produced invalid JSON arguments for ${call.function.name}`);
    }
    return { id: call.id, name: call.function.name, input };
  });

  return {
    text: choice.message.content ?? '',
    toolCalls,
    stopReason: choice.finish_reason,
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
    if (!apiKey) throw new ProviderError('Add an Anthropic API key to use the assistant.');
    return callAnthropic(config, apiKey, system, messages, tools, signal);
  }
  if (config.kind === 'openai') {
    return callOpenAi(config, apiKey, system, messages, tools, signal);
  }
  return Promise.reject(
    new ProviderError('No AI provider is connected. Open AI settings to connect one.'),
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
