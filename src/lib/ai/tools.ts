import { isSensitivePath, normalizePath, readableFiles } from '@/lib/vfs';
import { classify } from '@/lib/ai/approval';
import { searchContents, DEFAULT_SEARCH_OPTIONS } from '@/lib/search';
import { buildTree, type TreeNode } from '@/lib/vfs';
import {
  ENVIRONMENT_LABEL,
  TERMINAL_ENVIRONMENTS,
  type TerminalEnvironment,
} from '@/stores/terminalStore';
import {
  AGENT_PANELS,
  AGENT_PANEL_NAMES,
  panelFor,
  readLine,
  type IdeActions,
} from '@/lib/ai/ideActions';

/**
 * Tools the coding agent may call.
 *
 * Every tool executes for real against the workspace — nothing here fabricates
 * a result. Write tools are gated: they are only exposed when the caller has
 * editor permission on the project, and each one re-normalises its path so a
 * model cannot talk the agent into writing outside the project or into a
 * sensitive location.
 */

export interface ToolContext {
  files: Record<string, string>;
  dirs: string[];
  /** Permission of the signed-in user on this project. */
  canWrite: boolean;
  /**
   * Whether the user has approved irreversible actions for this session.
   * Deleting a file has no undo in the workspace, so it is opt-in rather than
   * something the model can decide on its own.
   */
  allowDestructive: boolean;
  writeFile(path: string, content: string): void;
  deletePath(path: string): void;
  runShell(command: string): Promise<string>;
  /**
   * Recent output from one terminal environment.
   *
   * The environment is explicit because the three are different machines. An
   * agent reasoning about a failing build must not be shown a Linux
   * workspace's scrollback as though it were the project's.
   */
  terminalOutput(environment?: TerminalEnvironment): string;
  /**
   * Ask the user, in the moment, about an action that cannot be undone.
   *
   * Optional: without it the session-wide `allowDestructive` flag is the only
   * gate, which is the behaviour every non-interactive caller gets. When the
   * agent supplies it, the user sees what will happen before it does.
   */
  requestApproval?(action: string, affects: string[]): Promise<boolean>;
  /**
   * Has this file changed since the agent read it in this task?
   *
   * Supplied by the store, backed by the same cache that decides whether a
   * re-read needs resending. Optional so a non-interactive caller — every
   * test harness — behaves exactly as before.
   */
  isStaleRead?(path: string, content: string): boolean;
  /**
   * Compile the project for real, through the same bundler the preview uses.
   * Absent in contexts with no build available.
   */
  runBuild?(): Promise<{ ok: boolean; report: string }>;
  /** Current editor diagnostics, newest analysis. */
  diagnostics?(): string;
  /**
   * The project's real environment, when a container workspace is connected.
   *
   * Optional, and its absence is reported rather than hidden: without a
   * gateway the agent is told there is no workspace instead of being handed a
   * tool that pretends to have run something.
   */
  workspace?: {
    connected(): boolean;
    /** Which of the project's checks exist, or a reason none can be listed. */
    listChecks(): Promise<{ ok: boolean; available?: string[]; message?: string }>;
    /** Run one named check. A failing check is a result, not an error. */
    runCheck(script: string): Promise<{
      ok: boolean;
      result?: { script: string; ok: boolean; exitCode: number; output: string; truncated: boolean };
      message?: string;
    }>;
    /** Real `git status` from the container. */
    gitStatus(): Promise<{ ok: boolean; data?: unknown; message?: string }>;
    /** Real `git diff` from the container. */
    gitDiff(staged: boolean): Promise<{ ok: boolean; data?: unknown; message?: string }>;
  };
  /**
   * The project's uncommitted changes as a unified diff.
   *
   * Absent when there is no repository. A review workflow that cannot read
   * the diff has to say so rather than guessing from file contents.
   */
  gitDiff?(): string;
  /** Called after any tool changes a file, for the task's change ledger. */
  onChange?(path: string, kind: 'created' | 'modified' | 'deleted', before: string, after: string): void;
  /**
   * Given a file the agent is about to be shown, return what to actually send.
   *
   * Lets the task skip resending a file the agent already has in context. It
   * must return the real content whenever the file has changed — the saving is
   * never allowed to cost correctness.
   */
  onRead?(path: string, content: string): { text: string; cached: boolean };
  /**
   * How many files this task has already changed, and where the check-in sits.
   *
   * A single edit is routine; a long unattended run rewriting much of the
   * project is not. Absent, edits never pause — which is what a
   * non-interactive caller gets.
   */
  changedSoFar?(): number;
  wideChangeThreshold?: number | null;
  /**
   * The interface, when there is one to drive.
   *
   * Absent in every headless context, and its absence is reported: an agent
   * told "there is no editor here" is right, and one that says "opened it"
   * having opened nothing is the fabrication these tools exist to avoid.
   */
  ide?: IdeActions;
}

/** Matches the per-file limit the database enforces on project_files.content. */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/** Shell commands that destroy work irreversibly. */
const DESTRUCTIVE_COMMANDS = new Set(['rm']);

export function isDestructiveCommand(command: string): boolean {
  const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return DESTRUCTIVE_COMMANDS.has(head);
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  input_schema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description: string;
        /**
         * The permitted values, where a parameter names one of a fixed set.
         *
         * Carried to the provider as JSON Schema so the model is told the
         * choices rather than left to guess them — and re-checked in the tool,
         * because a schema is a hint to the model and never a guarantee.
         */
        enum?: readonly string[];
      }
    >;
    required: string[];
  };
  mutates: boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function requirePath(input: Record<string, unknown>, key = 'path'): string {
  const raw = input[key];
  if (typeof raw !== 'string') throw new ToolError(`"${key}" must be a string`);

  /*
   * Refuse an absolute path outright rather than letting it be reinterpreted.
   *
   * `normalizePath` treats a leading slash as "project root", which is the
   * right convention for the explorer and the shell — `cd /` means the project
   * root there. It is the wrong one here: a model that emits `/etc/passwd`
   * means the host file system, and quietly turning that into `etc/passwd`
   * inside the project would create a file the user never asked for while
   * looking like it succeeded. The agent gets project-relative paths only.
   */
  const candidate = raw.trim().replace(/\\/g, '/');
  if (candidate.startsWith('/')) {
    throw new ToolError(
      `"${raw}" is an absolute path. Use a project-relative path such as "src/app.ts".`,
    );
  }
  if (/^[A-Za-z]:/.test(candidate)) {
    throw new ToolError(`"${raw}" is an absolute path. Use a project-relative path.`);
  }

  const path = normalizePath(candidate);
  if (isSensitivePath(path)) {
    throw new ToolError(`Access to "${path}" is blocked by the workspace policy.`);
  }
  return path;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const raw = input[key];
  if (typeof raw !== 'string') throw new ToolError(`"${key}" must be a string`);
  return raw;
}

function requireContent(input: Record<string, unknown>, key: string): string {
  const value = requireString(input, key);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_WRITE_BYTES) {
    throw new ToolError(
      `"${key}" is ${Math.round(bytes / 1024)} KB, over the ${MAX_WRITE_BYTES / 1024 / 1024} MB per-file limit`,
    );
  }
  return value;
}

/**
 * Gate an irreversible action.
 *
 * Order matters. A standing session approval short-circuits, so a user who has
 * opted in is not asked repeatedly. Otherwise the interactive prompt runs when
 * the caller provides one. Only when there is neither does this fall back to
 * refusing outright — which is what any non-interactive caller gets, and is
 * the conservative default.
 */
async function requireApproval(
  action: string,
  affects: string[],
  ctx: ToolContext,
): Promise<void> {
  if (ctx.allowDestructive) return;
  if (ctx.requestApproval) {
    const granted = await ctx.requestApproval(action, affects);
    if (granted) return;
    throw new ToolError(`${action} was declined.`);
  }
  throw new ToolError(
    `${action} is blocked: destructive actions are off for this session. ` +
      'Turn on "Allow destructive actions" in the assistant panel to permit it.',
  );
}

/**
 * One check-in partway through a long run of edits.
 *
 * Editing a file is recoverable, so each one runs unattended; what needs a
 * human is the pattern — twenty files into a task nobody watched. The
 * threshold, and whether to check in at all, comes from settings.
 */
async function checkWideChange(path: string, tool: string, ctx: ToolContext): Promise<void> {
  if (!ctx.changedSoFar) return;
  const { decision, request } = classify({
    tool,
    input: { path },
    changedSoFar: ctx.changedSoFar(),
    wideChangeThreshold: ctx.wideChangeThreshold,
  });
  if (decision === 'auto' || !request) return;
  await requireApproval(request.what, request.affects, ctx);
}

function renderTree(nodes: TreeNode[], depth = 0, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(`${'  '.repeat(depth)}${node.name}${node.type === 'dir' ? '/' : ''}`);
    if (node.type === 'dir') renderTree(node.children, depth + 1, out);
    if (out.length > 400) return out;
  }
  return out;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List every file path in the project. Use this first to understand the layout before reading files.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => Object.keys(ctx.files).sort().join('\n') || '(the project has no files)',
  },
  {
    name: 'get_project_structure',
    description: 'Return the project as an indented directory tree.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => renderTree(buildTree(ctx.files, ctx.dirs)).join('\n'),
  },
  {
    name: 'read_file',
    description: 'Read the full contents of one file, with line numbers.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project relative file path' } },
      required: ['path'],
    },
    mutates: false,
    run: (input, ctx) => {
      const path = requirePath(input);
      const content = ctx.files[path];
      if (content === undefined) throw new ToolError(`No such file: ${path}`);
      const view = ctx.onRead?.(path, content);
      if (view?.cached) return view.text;
      return content
        .split('\n')
        .map((line, index) => `${String(index + 1).padStart(4)}| ${line}`)
        .join('\n');
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents with a literal string or a regular expression.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find' },
        regex: { type: 'string', description: '"true" to treat the query as a regular expression' },
      },
      required: ['query'],
    },
    mutates: false,
    run: (input, ctx) => {
      const query = requireString(input, 'query');
      const result = searchContents(readableFiles(ctx.files), {
        ...DEFAULT_SEARCH_OPTIONS,
        query,
        regex: input.regex === 'true' || input.regex === true,
        maxResults: 80,
      });
      if (!result.matches.length) return `No matches for ${query}`;
      return result.matches
        .map((m) => `${m.path}:${m.line}:${m.column}  ${m.preview.trim()}`)
        .join('\n');
    },
  },
  {
    name: 'write_file',
    description:
      'Create a file or replace its entire contents. Prefer edit_file for small changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project relative file path' },
        content: { type: 'string', description: 'Complete new file contents' },
      },
      required: ['path', 'content'],
    },
    mutates: true,
    run: async (input, ctx) => {
      const path = requirePath(input);
      const content = requireContent(input, 'content');
      await checkWideChange(path, 'write_file', ctx);
      const before = ctx.files[path];
      // A whole-file write has no anchor, so nothing else would notice that the
      // user edited this file since the agent read it — it would just replace
      // their work. Refuse and say why; the agent can re-read and try again.
      if (before !== undefined && ctx.isStaleRead?.(path, before)) {
        throw new ToolError(
          `${path} changed after you read it — someone edited it in the editor. ` +
            'Read it again and rebase your change on the current contents.',
        );
      }
      ctx.writeFile(path, content);
      ctx.onChange?.(path, before === undefined ? 'created' : 'modified', before ?? '', content);
      return `Wrote ${path} (${content.split('\n').length} lines)`;
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string inside a file. The old_string must appear exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project relative file path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    mutates: true,
    run: async (input, ctx) => {
      const path = requirePath(input);
      const oldString = requireString(input, 'old_string');
      const newString = requireString(input, 'new_string');
      await checkWideChange(path, 'edit_file', ctx);
      const content = ctx.files[path];
      if (content === undefined) throw new ToolError(`No such file: ${path}`);
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) throw new ToolError(`old_string was not found in ${path}`);
      if (occurrences > 1) {
        throw new ToolError(
          `old_string appears ${occurrences} times in ${path}; include more context to make it unique`,
        );
      }
      const updated = content.replace(oldString, newString);
      if (new TextEncoder().encode(updated).length > MAX_WRITE_BYTES) {
        throw new ToolError(`The edit would push ${path} over the per-file size limit`);
      }
      ctx.writeFile(path, updated);
      ctx.onChange?.(path, 'modified', content, updated);
      return `Edited ${path}`;
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project relative file path' } },
      required: ['path'],
    },
    mutates: true,
    run: async (input, ctx) => {
      const path = requirePath(input);
      if (!(path in ctx.files)) throw new ToolError(`No such file: ${path}`);
      const before = ctx.files[path];
      await requireApproval(`Deleting ${path}`, [path], ctx);
      ctx.deletePath(path);
      ctx.onChange?.(path, 'deleted', before, '');
      return `Deleted ${path}`;
    },
  },
  {
    name: 'run_command',
    /*
     * The in-browser project shell, and nothing else.
     *
     * There is deliberately no tool that types into a container's PTY. The
     * Project Terminal (Linux) and the Linux Terminal are real shells on a
     * real machine, and "the model decided to" is not an authorisation
     * decision for one — the agent reaches the container only through typed
     * git operations and the five-name check allowlist, both of which the
     * gateway validates. Saying so in the description matters: an agent that
     * believes this is a Linux shell will write commands for one and read
     * their failure as a project problem.
     */
    description:
      'Run a command in the Project Terminal — TA CODE\'s in-browser shell over this project\'s ' +
      'files (for example "build", "git status", "npm ls"). Returns the real output. This is NOT ' +
      'the Linux Terminal and NOT a container shell: it has no host, no network and no processes. ' +
      'To run the project\'s real tests, lint, typecheck or build in its Linux container, use ' +
      'run_project_check instead.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command line' } },
      required: ['command'],
    },
    mutates: true,
    run: async (input, ctx) => {
      const command = requireString(input, 'command');
      if (isDestructiveCommand(command)) {
        await requireApproval(`Running "${command}"`, [command], ctx);
      }
      return ctx.runShell(command);
    },
  },
  {
    name: 'get_terminal_output',
    description:
      'Read the recent output of a terminal. Name which environment: "project" is the in-browser ' +
      'Project Terminal, "project-container" is this project in its Linux container, and "linux" ' +
      'is the separate Linux Terminal, which holds none of this project\'s files. Defaults to ' +
      'the Project Terminal.',
    input_schema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          enum: ['project', 'project-container', 'linux'],
          description: 'Which terminal environment to read.',
        },
      },
      required: [],
    },
    mutates: false,
    run: (input, ctx) => {
      const requested = (input as { environment?: unknown }).environment;
      // An unrecognised value is refused rather than silently read as the
      // project's: answering the wrong machine's output to a specific question
      // is worse than answering none.
      if (requested !== undefined && !TERMINAL_ENVIRONMENTS.includes(requested as TerminalEnvironment)) {
        throw new ToolError(
          `Unknown terminal environment "${String(requested)}". Use one of: ${TERMINAL_ENVIRONMENTS.join(', ')}.`,
        );
      }
      const environment = (requested as TerminalEnvironment) ?? 'project';
      const output = ctx.terminalOutput(environment);
      return output || `(${ENVIRONMENT_LABEL[environment]} has no output yet)`;
    },
  },
  {
    name: 'run_build',
    /*
     * Real verification, not a claim of one. This compiles the project with
     * the same esbuild-wasm pipeline the preview uses, so a reported success
     * means the code actually built and a reported failure carries the real
     * diagnostics. There is no Node process in the browser, so `npm test` and
     * `tsc` are not available here — the agent is told that rather than being
     * given a tool that pretends.
     */
    description:
      'Compile the project with the real bundler and return the result. Use this to verify a change actually builds.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: async (_input, ctx) => {
      if (!ctx.runBuild) return 'A build is not available in this context.';
      const result = await ctx.runBuild();
      return result.report;
    },
  },
  {
    name: 'get_diff',
    description:
      'Read the uncommitted changes in this project as a unified diff. Use this before reviewing ' +
      'changes, so the review is about what actually changed rather than the whole file.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => {
      if (!ctx.gitDiff) return 'No repository is available in this context.';
      return ctx.gitDiff() || 'The working tree is clean — there are no uncommitted changes.';
    },
  },
  {
    name: 'list_project_checks',
    /*
     * The honest first step of verification. The agent asks what this project
     * can actually run before claiming it ran anything, and a project with no
     * test script is told so rather than being given a confusing npm error.
     */
    description:
      'List the project checks that can be run in the real container workspace (test, lint, ' +
      'typecheck, build, verify). Call this before run_project_check.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: async (_input, ctx) => {
      if (!ctx.workspace) return 'No container workspace is available in this context.';
      const answer = await ctx.workspace.listChecks();
      if (!answer.ok) return answer.message ?? 'The workspace could not be reached.';
      if (!answer.available?.length) {
        return 'This project defines none of the runnable checks (test, lint, typecheck, build, verify).';
      }
      return `Runnable checks: ${answer.available.join(', ')}`;
    },
  },
  {
    name: 'run_project_check',
    /*
     * Real verification in the project's real environment — `npm test` in a
     * container with the project's dependencies, not the in-browser bundler.
     *
     * The agent names a script, never a command line. The gateway holds a
     * five-name allowlist and confirms `package.json` defines the script, so
     * there is no path from a model's output to a shell. A failing check comes
     * back as output to read rather than as an error to retry.
     */
    description:
      'Run one of the project\'s own checks in the real container workspace and return its real ' +
      'output and exit code. Allowed: test, lint, typecheck, build, verify. Use this to verify a ' +
      'change actually works, not just that it compiles.',
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'One of: test, lint, typecheck, build, verify',
        },
      },
      required: ['script'],
    },
    mutates: false,
    run: async (input, ctx) => {
      if (!ctx.workspace) return 'No container workspace is available in this context.';
      const script = requireString(input, 'script').trim();
      const answer = await ctx.workspace.runCheck(script);
      if (!answer.ok || !answer.result) {
        return answer.message ?? 'The check could not be run.';
      }
      const { result } = answer;
      const heading = result.ok
        ? `${result.script} passed (exit ${result.exitCode}).`
        : `${result.script} FAILED (exit ${result.exitCode}).`;
      const body = result.output.trim();
      return body ? `${heading}\n\n${body}` : heading;
    },
  },
  {
    name: 'get_git_status',
    /*
     * Real git, from Phase 2, rather than the in-browser version control. The
     * two can disagree, and when they do the container's answer is the one that
     * matters — it is what a commit will actually record.
     */
    description:
      'Read the real git status of the container workspace: branch, and which files are staged, ' +
      'modified or untracked.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: async (_input, ctx) => {
      if (!ctx.workspace) return 'No container workspace is available in this context.';
      const answer = await ctx.workspace.gitStatus();
      if (!answer.ok) return answer.message ?? 'Git status could not be read.';
      const state = answer.data as {
        repository?: boolean;
        branch?: string | null;
        dirty?: boolean;
        files?: Array<{ path: string; code: string; staged: boolean; untracked: boolean }>;
      };
      if (!state?.repository) return 'This workspace has no git repository yet.';
      if (!state.dirty) return `On branch ${state.branch ?? '(detached)'} — working tree clean.`;
      const lines = (state.files ?? [])
        .slice(0, 100)
        .map((file) => `  ${file.code} ${file.path}${file.staged ? ' (staged)' : ''}`);
      return [`On branch ${state.branch ?? '(detached)'}:`, ...lines].join('\n');
    },
  },
  {
    name: 'get_workspace_diff',
    description:
      'Read the real unified diff from the container workspace. Pass staged=true for the staged ' +
      'changes instead of the working tree.',
    input_schema: {
      type: 'object',
      properties: {
        staged: { type: 'string', description: '"true" to diff the staged changes' },
      },
      required: [],
    },
    mutates: false,
    run: async (input, ctx) => {
      if (!ctx.workspace) return 'No container workspace is available in this context.';
      const staged = String((input as { staged?: unknown }).staged ?? '') === 'true';
      const answer = await ctx.workspace.gitDiff(staged);
      if (!answer.ok) return answer.message ?? 'The diff could not be read.';
      const patch = String(answer.data ?? '');
      return patch.trim() || 'No changes.';
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'Read the current editor problems (type errors, syntax errors) for the project.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => {
      if (!ctx.diagnostics) return 'Diagnostics are not available in this context.';
      return ctx.diagnostics() || 'No problems reported.';
    },
  },

  /*
   * Driving the interface.
   *
   * "Open src/App.tsx" should open the file rather than describe how to. These
   * change what is on screen and nothing else — no tool here closes, hides or
   * discards anything, because an agent that can take a panel away from the
   * person watching it is a different kind of thing from one that can bring a
   * panel forward.
   *
   * Each refuses an unknown target by name. A navigation that quietly does
   * nothing is the worst outcome: the agent reports it as done and the screen
   * has not moved.
   */
  {
    name: 'open_file',
    description:
      'Open a file in the editor so the user can see it, optionally putting the caret on a line. ' +
      'Use this whenever the user asks to open, show or go to a file. This does not return the ' +
      'file contents — use read_file for that.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project relative file path' },
        line: { type: 'number', description: 'Optional 1-based line to reveal' },
      },
      required: ['path'],
    },
    mutates: false,
    run: (input, ctx) => {
      const path = requirePath(input);
      if (ctx.files[path] === undefined) {
        throw new ToolError(`No such file: ${path}. Use list_files to see what exists.`);
      }
      if (!ctx.ide) return 'There is no editor open in this context, so nothing was opened.';
      const line = readLine((input as { line?: unknown }).line);
      ctx.ide.openFile(path, line);
      return line ? `Opened ${path} at line ${line}.` : `Opened ${path}.`;
    },
  },
  {
    name: 'open_panel',
    description:
      'Bring one of the IDE panels forward so the user can see it. Use this when the user asks ' +
      'to open or show a tool by name.',
    input_schema: {
      type: 'object',
      properties: {
        panel: {
          type: 'string',
          enum: AGENT_PANEL_NAMES,
          description: Object.entries(AGENT_PANELS)
            .map(([name, entry]) => `${name} (${entry.description})`)
            .join('; '),
        },
      },
      required: ['panel'],
    },
    mutates: false,
    run: (input, ctx) => {
      const name = requireString(input, 'panel');
      const panel = panelFor(name);
      if (!panel) {
        throw new ToolError(
          `Unknown panel "${name}". Use one of: ${AGENT_PANEL_NAMES.join(', ')}.`,
        );
      }
      if (!ctx.ide) return 'There is no workspace open in this context, so nothing was opened.';
      ctx.ide.openPanel(panel);
      return `Opened the ${name} panel.`;
    },
  },
  {
    name: 'open_preview',
    description:
      'Show the live preview, building it if it is not already running. Use this after a change ' +
      'the user should look at.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => {
      if (!ctx.ide) return 'There is no workspace open in this context, so nothing was opened.';
      ctx.ide.openPreview();
      return 'Opened the preview.';
    },
  },
  {
    name: 'open_problems',
    description:
      'Show the Problems list, where type and syntax errors are reported. Use get_diagnostics to ' +
      'read them yourself; use this to put them in front of the user.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => {
      if (!ctx.ide) return 'There is no workspace open in this context, so nothing was opened.';
      ctx.ide.openProblems();
      return 'Opened the Problems panel.';
    },
  },
];

/** Tools available given the caller's permission on the project. */
export function toolsFor(canWrite: boolean): ToolDefinition[] {
  return canWrite ? TOOLS : TOOLS.filter((tool) => !tool.mutates);
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  if (tool.mutates && !ctx.canWrite) {
    throw new ToolError(
      `"${name}" needs editor permission on this project. Your role is read-only.`,
    );
  }
  return tool.run(input, ctx);
}
