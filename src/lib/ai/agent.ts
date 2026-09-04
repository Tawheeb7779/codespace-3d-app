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
  /** Fired before a tool runs, so the task can move to the right phase. */
  onToolStart?: (tool: string, input: Record<string, unknown>) => void;
  /** The plan the agent stated before acting, when it produced one. */
  onPlan?: (plan: string[]) => void;
  /** Ask the agent to verify edits with a real build. Defaults to on. */
  verifyAfterEdits?: boolean;
}

export const MAX_STEPS = 12;

/**
 * How many times the agent may react to a failing verification before it has
 * to stop and explain. Without a bound, a model that cannot fix a build error
 * will keep editing and rebuilding until the step limit, burning tokens and
 * churning the project.
 */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Pull a plan out of the model's prose.
 *
 * The agent is asked for a numbered or bulleted plan before it acts on a
 * non-trivial task. This reads that back for the UI without a second model
 * call — a structured "plan tool" would cost a round trip for something the
 * text already contains.
 */
export function extractPlan(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:\d+[.)]|[-*])\s+(.{3,200})$/.exec(line);
    if (match) steps.push(match[1].trim());
  }
  return steps.slice(0, 12);
}

const BASE_RULES = `You are the coding assistant inside Forge IDE, working on the user's project.

Rules:
- Inspect before you change. Read the files you intend to touch.
- Use edit_file for targeted changes and write_file only for new or fully rewritten files.
- Never claim you changed a file unless a tool call actually succeeded.
- Keep answers short. Point at file paths and line numbers instead of pasting large blocks.
- If a request needs a capability you do not have, say so plainly.
- For anything beyond a one-line change, state a short numbered plan first, then carry it out.
- There is no Node process here, so npm test, tsc and npm run <script> do not exist. run_build and
  get_diagnostics are the real checks available. Never claim to have run anything else.`;

const VERIFY_RULES = `
- Verify your work: after editing code, call run_build (a real compile) or get_diagnostics, and
  read the result. Only say a change works once a check has actually passed.
- If a check fails twice and you still cannot fix it, stop and explain what is wrong.`;

/**
 * Verification is on by default and can be turned off in settings, for a
 * project where a build is slow or meaningless. Turning it off relaxes what
 * the agent is asked to run — never what it is allowed to claim.
 */
const NO_VERIFY_RULES = `
- Automatic verification is turned off for this project, so do not run a build unless the user
  asks. Say what you changed; do not claim it builds or passes when you have not checked.`;

export function systemPrompt(verifyAfterEdits = true): string {
  return BASE_RULES + (verifyAfterEdits ? VERIFY_RULES : NO_VERIFY_RULES);
}

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
    case 'run_build':
      return 'Building the project';
    case 'get_diagnostics':
      return 'Reading editor problems';
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
    const response = await complete(
      config,
      apiKey,
      systemPrompt(turn.verifyAfterEdits ?? true),
      messages,
      tools,
      signal,
    );

    if (response.text) {
      finalText = response.text;
      turn.onText(response.text);
      // The first substantive message is where a plan appears, if there is one.
      if (steps === 1 && turn.onPlan) {
        const plan = extractPlan(response.text);
        if (plan.length > 1) turn.onPlan(plan);
      }
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
      turn.onToolStart?.(call.name, call.input);
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

      // A tool that resolved while the user was cancelling must not feed its
      // result back and provoke another model call.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

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
