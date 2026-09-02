import {
  complete,
  toolResultMessage,
  type ChatMessage,
  type ProviderConfig,
} from '@/lib/ai/provider';
import { runTool, toolsFor, type ToolContext } from '@/lib/ai/tools';
import { errorMessage, uid } from '@/lib/utils';

/**
 * The agent loop: ask the model, run whatever tools it requests against the
 * real workspace, feed the real results back, repeat until it answers.
 *
 * Every tool call is reported through `onActivity` before and after it runs, so
 * the panel shows what actually happened rather than a scripted animation.
 */

export type ActivityState = 'pending' | 'running' | 'done' | 'error';

export interface AgentActivity {
  id: string;
  tool: string;
  detail: string;
  state: ActivityState;
  result?: string;
}

export interface AgentTurn {
  onActivity: (activity: AgentActivity) => void;
  onText: (text: string) => void;
}

export const MAX_STEPS = 12;

const SYSTEM_PROMPT = `You are the coding assistant inside Forge IDE, working on the user's project.

Rules:
- Inspect before you change. Read the files you intend to touch.
- Use edit_file for targeted changes and write_file only for new or fully rewritten files.
- Never claim you changed a file unless a tool call actually succeeded.
- Keep answers short. Point at file paths and line numbers instead of pasting large blocks.
- If a request needs a capability you do not have, say so plainly.`;

function describe(tool: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : '';
  switch (tool) {
    case 'read_file':
      return `Reading ${path}`;
    case 'write_file':
      return `Writing ${path}`;
    case 'edit_file':
      return `Editing ${path}`;
    case 'delete_file':
      return `Deleting ${path}`;
    case 'search_files':
      return `Searching for "${String(input.query ?? '')}"`;
    case 'run_command':
      return `Running ${String(input.command ?? '')}`;
    case 'list_files':
      return 'Listing project files';
    case 'get_project_structure':
      return 'Reading project structure';
    case 'get_terminal_output':
      return 'Reading terminal output';
    default:
      return tool;
  }
}

export interface AgentResult {
  text: string;
  transcript: ChatMessage[];
  steps: number;
}

export async function runAgent(
  config: ProviderConfig,
  apiKey: string,
  transcript: ChatMessage[],
  ctx: ToolContext,
  turn: AgentTurn,
  signal: AbortSignal,
): Promise<AgentResult> {
  const messages = [...transcript];
  const tools = toolsFor(ctx.canWrite);
  let finalText = '';
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps += 1;
    const response = await complete(config, apiKey, SYSTEM_PROMPT, messages, tools, signal);

    if (response.text) {
      finalText = response.text;
      turn.onText(response.text);
    }

    if (!response.toolCalls.length) {
      messages.push({ role: 'assistant', content: response.raw });
      return { text: finalText, transcript: messages, steps };
    }

    messages.push({ role: 'assistant', content: response.raw });

    for (const call of response.toolCalls) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const activityId = uid('act');
      const detail = describe(call.name, call.input);
      turn.onActivity({ id: activityId, tool: call.name, detail, state: 'running' });

      let result: string;
      let isError = false;
      try {
        result = await runTool(call.name, call.input, ctx);
        turn.onActivity({ id: activityId, tool: call.name, detail, state: 'done', result });
      } catch (error) {
        isError = true;
        result = errorMessage(error);
        turn.onActivity({ id: activityId, tool: call.name, detail, state: 'error', result });
      }

      messages.push(
        toolResultMessage(
          config.kind,
          call.id,
          call.name,
          result.slice(0, 20_000),
          isError,
        ) as ChatMessage,
      );
    }
  }

  throw new Error(
    `The assistant stopped after ${MAX_STEPS} steps without finishing. Narrow the request and try again.`,
  );
}
