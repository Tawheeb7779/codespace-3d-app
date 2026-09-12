// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '@/lib/ai/agent';
import { forgetStreamingRefusals, type ProviderConfig } from '@/lib/ai/provider';
import type { ToolContext } from '@/lib/ai/tools';

/**
 * The agent loop over a streamed provider, with nothing mocked below the wire.
 *
 * `complete` is the real transport here, not a spy: the only stub is `fetch`,
 * so what is being checked is that a streamed step reaches the panel's callback
 * as it is produced and still ends up a correct step — the same tool calls, the
 * same transcript, the same stop.
 *
 * The case worth the most is the second one. Text is handed over cumulatively,
 * and a turn is several steps, so a caller that appended instead of replacing
 * would show step two's answer welded onto step one's. That reads as the model
 * repeating itself and is invisible in a single-step test.
 */

const CONFIG: ProviderConfig = { kind: 'openai', model: 'm', baseUrl: 'http://provider.test/v1' };

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
const usageChunk = (input: number, output: number) =>
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })}\n\n`;
const DONE = 'data: [DONE]\n\n';

/** One stream per model call, in order. */
function stubFetch(steps: string[][]) {
  const bodies: Array<Record<string, unknown>> = [];
  let index = 0;
  const impl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const frames = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
  vi.stubGlobal('fetch', impl);
  return { impl, bodies };
}

function workspace(): ToolContext {
  const files: Record<string, string> = { 'a.ts': 'export const a = 1;\n' };
  return {
    get files() {
      return files;
    },
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: (path, content) => {
      files[path] = content;
    },
    deletePath: (path) => {
      delete files[path];
    },
    runShell: async () => 'ok',
    terminalOutput: () => '',
    onChange: () => undefined,
  };
}

async function drive(steps: string[][], options: { stream?: boolean } = {}) {
  const seen: string[] = [];
  const { bodies } = stubFetch(steps);
  const result = await runAgent(
    CONFIG,
    'key',
    [{ role: 'user', content: 'do the thing' }],
    workspace(),
    {
      onActivity: () => undefined,
      onText: (text) => seen.push(text),
      ...(options.stream === false ? { stream: false as const } : {}),
    },
    new AbortController().signal,
  );
  return { result, seen, bodies };
}

beforeEach(() => {
  forgetStreamingRefusals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a streamed agent step', () => {
  it('reports the answer while it is being written, then finishes with it', async () => {
    const { result, seen } = await drive([
      [chunk({ content: 'Looking' }), chunk({ content: ' at it' }), chunk({}, { finish_reason: 'stop' }), DONE],
    ]);

    // Progressive, and the last value is the whole answer — so a caller that
    // renders whatever it was last given is correct at every moment.
    expect(seen.slice(0, 2)).toEqual(['Looking', 'Looking at it']);
    expect(seen[seen.length - 1]).toBe('Looking at it');
    expect(result.text).toBe('Looking at it');
  });

  it('asks the provider to stream by default', async () => {
    const { bodies } = await drive([[chunk({ content: 'x' }), DONE]]);

    expect(bodies[0].stream).toBe(true);
  });

  it('makes one whole request when the caller does not want a stream', async () => {
    vi.unstubAllGlobals();
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', impl);

    const seen: string[] = [];
    const result = await runAgent(
      CONFIG,
      'key',
      [{ role: 'user', content: 'hi' }],
      workspace(),
      { onActivity: () => undefined, onText: (text) => seen.push(text), stream: false },
      new AbortController().signal,
    );

    expect(result.text).toBe('whole');
    expect(seen).toEqual(['whole']);
    const [, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBeUndefined();
  });

  /**
   * A streamed tool call has to survive being reassembled and then sent back
   * as transcript, or the second step asks the model to continue from a
   * message it never wrote.
   */
  it('runs a tool the model streamed, and carries the call into the next step', async () => {
    const { result, seen } = await drive([
      [
        chunk({ content: 'Reading first.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
        DONE,
      ],
      [chunk({ content: 'It exports a.' }), chunk({}, { finish_reason: 'stop' }), DONE],
    ]);

    expect(result.steps).toBe(2);
    expect(result.text).toBe('It exports a.');
    // The second step's text replaced the first step's rather than running on
    // from the end of it.
    expect(seen[seen.length - 1]).toBe('It exports a.');
    expect(seen).not.toContain('Reading first.It exports a.');

    const toolResult = result.transcript.find(
      (message) => (message as { role: string }).role === 'tool',
    ) as { tool_call_id?: string; content?: string } | undefined;
    expect(toolResult?.tool_call_id).toBe('call_1');
    expect(toolResult?.content).toContain('export const a = 1;');
  });
});

describe('what the turn cost', () => {
  it('adds up only what the provider reported, and says how much it covered', async () => {
    const { result } = await drive([
      [
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
        usageChunk(100, 10),
        DONE,
      ],
      [chunk({ content: 'done' }), chunk({}, { finish_reason: 'stop' }), usageChunk(250, 40)],
    ]);

    expect(result.usage).toEqual({ inputTokens: 350, outputTokens: 50, reported: 2, steps: 2 });
  });

  /**
   * Not every provider volunteers usage, and a sum across some of the steps is
   * a floor rather than a total. `reported` is what lets the panel say which.
   */
  it('keeps a turn the provider said nothing about unreported', async () => {
    const { result } = await drive([[chunk({ content: 'quiet' }), chunk({}, { finish_reason: 'stop' }), DONE]]);

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, reported: 0, steps: 1 });
  });
});
