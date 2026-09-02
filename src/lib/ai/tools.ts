import { isSensitivePath, normalizePath } from '@/lib/vfs';
import { searchContents, DEFAULT_SEARCH_OPTIONS } from '@/lib/search';
import { buildTree, type TreeNode } from '@/lib/vfs';

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
  terminalOutput(): string;
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
    properties: Record<string, { type: string; description: string }>;
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
  const path = normalizePath(raw);
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

function requireApproval(action: string, ctx: ToolContext): void {
  if (ctx.allowDestructive) return;
  throw new ToolError(
    `${action} is blocked: destructive actions are off for this session. ` +
      'Turn on "Allow destructive actions" in the assistant panel to permit it.',
  );
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
      const result = searchContents(ctx.files, {
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
    run: (input, ctx) => {
      const path = requirePath(input);
      const content = requireContent(input, 'content');
      ctx.writeFile(path, content);
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
    run: (input, ctx) => {
      const path = requirePath(input);
      const oldString = requireString(input, 'old_string');
      const newString = requireString(input, 'new_string');
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
    run: (input, ctx) => {
      const path = requirePath(input);
      if (!(path in ctx.files)) throw new ToolError(`No such file: ${path}`);
      requireApproval(`Deleting ${path}`, ctx);
      ctx.deletePath(path);
      return `Deleted ${path}`;
    },
  },
  {
    name: 'run_command',
    description:
      'Run a Forge Shell command in the workspace (for example "build", "git status", "npm ls"). Returns the real output.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command line' } },
      required: ['command'],
    },
    mutates: true,
    run: (input, ctx) => {
      const command = requireString(input, 'command');
      if (isDestructiveCommand(command)) requireApproval(`Running "${command}"`, ctx);
      return ctx.runShell(command);
    },
  },
  {
    name: 'get_terminal_output',
    description: 'Read the recent output of the active terminal session.',
    input_schema: { type: 'object', properties: {}, required: [] },
    mutates: false,
    run: (_input, ctx) => ctx.terminalOutput() || '(the terminal has no output yet)',
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
