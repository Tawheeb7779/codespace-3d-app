/**
 * What the agent may do on its own, and what it must ask for first.
 *
 * The rule is reversibility, not danger in the abstract. Reading anything is
 * free. Editing a file is recoverable — the change ledger keeps the previous
 * content and the diff viewer shows it — so it runs unattended. Anything that
 * destroys work, touches many files at once, or reaches outside the project
 * stops and asks, and the request says plainly what will happen and to what.
 */

export type ApprovalDecision = 'auto' | 'ask';

export interface ApprovalRequest {
  id: string;
  tool: string;
  /** One line: what is about to happen. */
  what: string;
  /** Why the agent wants it, in the agent's own words where available. */
  why: string;
  /** Concrete resources affected — file paths, or a command line. */
  affects: string[];
  /** Present when refusing outright rather than asking. */
  severity: 'destructive' | 'wide' | 'external';
}

/** Commands that destroy work irreversibly, matched on the head token. */
const DESTRUCTIVE_COMMANDS = new Set(['rm']);
/** Commands that reach past the project or change how it is wired up. */
const EXTERNAL_COMMANDS = new Set(['git', 'npm', 'export']);

/**
 * A single edit is routine; rewriting half the project in one call is not.
 * Above this many files touched in one task without a check-in, the agent
 * pauses so the user can see where it is going.
 */
export const WIDE_CHANGE_THRESHOLD = 10;

export function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMANDS.has(commandHead(command));
}

/** `git push`, `git commit`, `npm install` — real consequences outside the editor. */
export function isExternalCommand(command: string): boolean {
  const head = commandHead(command);
  if (!EXTERNAL_COMMANDS.has(head)) return false;
  // Read-only subcommands of those tools are still free.
  const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
  const readOnly = new Set(['status', 'log', 'diff', 'branch', 'remote', 'ls', 'list', 'fetch']);
  return !readOnly.has(sub);
}

export interface ClassifyInput {
  tool: string;
  input: Record<string, unknown>;
  /** Files the task has already changed, for the wide-change rule. */
  changedSoFar: number;
  /** The agent's stated reason, passed through to the user. */
  reason?: string;
}

/**
 * Decide whether a tool call runs unattended, and build the request if not.
 *
 * Returns `auto` for everything that is either read-only or recoverable. The
 * caller is still responsible for permission checks — this answers "does the
 * human need to see it first", not "is the caller allowed to".
 */
export function classify(call: ClassifyInput): { decision: ApprovalDecision; request?: Omit<ApprovalRequest, 'id'> } {
  const path = typeof call.input.path === 'string' ? call.input.path : '';
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const why = call.reason?.trim() || 'The agent asked for this as part of your request.';

  if (call.tool === 'delete_file') {
    return {
      decision: 'ask',
      request: {
        tool: call.tool,
        what: `Delete ${path}`,
        why,
        affects: [path],
        severity: 'destructive',
      },
    };
  }

  if (call.tool === 'run_command') {
    if (isDestructiveCommand(command)) {
      return {
        decision: 'ask',
        request: {
          tool: call.tool,
          what: `Run "${command}"`,
          why,
          affects: [command],
          severity: 'destructive',
        },
      };
    }
    if (isExternalCommand(command)) {
      return {
        decision: 'ask',
        request: {
          tool: call.tool,
          what: `Run "${command}"`,
          why,
          affects: [command],
          severity: 'external',
        },
      };
    }
    return { decision: 'auto' };
  }

  // A long unattended run of edits gets one check-in, not one per file.
  if (
    (call.tool === 'write_file' || call.tool === 'edit_file') &&
    call.changedSoFar >= WIDE_CHANGE_THRESHOLD
  ) {
    return {
      decision: 'ask',
      request: {
        tool: call.tool,
        what: `Keep editing — ${call.changedSoFar} files changed so far, next is ${path}`,
        why,
        affects: [path],
        severity: 'wide',
      },
    };
  }

  return { decision: 'auto' };
}

export const SEVERITY_LABELS: Record<ApprovalRequest['severity'], string> = {
  destructive: 'Destroys work',
  wide: 'Large change',
  external: 'Acts outside the editor',
};
