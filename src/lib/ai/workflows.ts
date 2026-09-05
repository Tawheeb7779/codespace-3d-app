import { isSensitivePath } from '@/lib/vfs';

/**
 * Named tasks for the coding agent.
 *
 * These are prompts, not a second agent. Each one produces the text of a
 * request that goes through exactly the same loop as anything typed by hand —
 * the same tools, path validation, approval gates, cancellation and build
 * verification. A workflow can therefore never do something the agent is not
 * already allowed to do; it only saves the user from writing the instruction.
 *
 * The one thing they must get right is not over-claiming. "Refactor" asks for
 * a verified change; "Review" and "Explain" are read-only and say so, because
 * an agent told to review that starts editing is a worse tool than one that
 * reports.
 */

export type WorkflowId =
  | 'explain'
  | 'refactor'
  | 'debug'
  | 'tests'
  | 'review'
  | 'optimize'
  | 'document';

export interface WorkflowScope {
  /** File the editor has open, when there is one. */
  path: string | null;
  /** Exact text the user selected, when they selected any. */
  selection: string;
  /** Whether the project currently reports errors or warnings. */
  hasDiagnostics: boolean;
  /** Whether the working tree has uncommitted changes. */
  hasChanges: boolean;
}

export interface Workflow {
  id: WorkflowId;
  label: string;
  /** One line for the menu. */
  description: string;
  /** True when the workflow is expected to modify files. */
  mutates: boolean;
  /** Why the workflow cannot run right now, or null when it can. */
  unavailable: (scope: WorkflowScope) => string | null;
  /** The instruction sent to the agent. */
  prompt: (scope: WorkflowScope) => string;
}

/** How much selected text to quote before it stops being a selection. */
export const MAX_SELECTION = 4000;

/**
 * Describe the target once, so every prompt refers to the same thing.
 *
 * A selection is quoted verbatim because the agent cannot see the editor; a
 * whole file is named rather than pasted, so the agent reads it with a tool
 * and the read goes through the protected-path check like any other.
 */
function target(scope: WorkflowScope): string {
  if (scope.selection.trim()) {
    const clipped = scope.selection.slice(0, MAX_SELECTION);
    const note = scope.selection.length > MAX_SELECTION ? '\n… (selection truncated)' : '';
    return [
      scope.path ? `The selected code in ${scope.path}:` : 'The selected code:',
      '```',
      clipped + note,
      '```',
    ].join('\n');
  }
  return `The file ${scope.path}.`;
}

/** Nothing to work on, and nothing a protected file may be used for. */
function needsFile(scope: WorkflowScope): string | null {
  if (!scope.path && !scope.selection.trim()) {
    return 'Open a file or select some code first.';
  }
  // The agent's own tools refuse these too; refusing here makes the reason
  // visible before a task starts rather than as a tool error inside one.
  if (scope.path && isSensitivePath(scope.path)) {
    return 'That file is protected by the workspace policy and cannot be sent to the model.';
  }
  return null;
}

export const WORKFLOWS: Workflow[] = [
  {
    id: 'explain',
    label: 'Explain',
    description: 'Describe what this code does, and why.',
    mutates: false,
    unavailable: needsFile,
    prompt: (scope) =>
      [
        target(scope),
        '',
        'Explain what this does and why it is written this way. Cover the control flow, any',
        'non-obvious decision, and anything that looks like a bug. Do not change any files —',
        'this is a read-only request.',
      ].join('\n'),
  },
  {
    id: 'refactor',
    label: 'Refactor',
    description: 'Propose and apply safe improvements.',
    mutates: true,
    unavailable: needsFile,
    prompt: (scope) =>
      [
        target(scope),
        '',
        'Refactor this for clarity without changing its behaviour. State a short numbered plan',
        'first. Keep each edit small and local; do not rename public API or restructure files',
        'beyond what you listed. When you are done, run a build and report the real result.',
      ].join('\n'),
  },
  {
    id: 'debug',
    label: 'Debug',
    description: 'Investigate the current errors and fix them.',
    mutates: true,
    unavailable: (scope) =>
      scope.hasDiagnostics
        ? null
        : 'Nothing is reporting an error right now. Run a build first if you expect one.',
    prompt: () =>
      [
        'The project is reporting problems.',
        '',
        'Work in this order: call get_diagnostics and read the actual errors; call get_diff if',
        'there are uncommitted changes, since a new failure usually comes from a recent one;',
        'read the files involved; then state a short plan before editing.',
        '',
        'Fix the cause, not just the line the error points at. Afterwards call run_build and',
        'report what the build actually said — including when it still fails. If you cannot',
        'reproduce or fix a problem, say so plainly rather than guessing.',
      ].join('\n'),
  },
  {
    id: 'tests',
    label: 'Generate tests',
    description: 'Write tests covering this code.',
    mutates: true,
    unavailable: needsFile,
    prompt: (scope) =>
      [
        target(scope),
        '',
        'Write tests for this. Cover the behaviour that would actually break — edge cases,',
        'error paths, boundaries — not one test per function for its own sake. Follow the',
        'conventions already used by tests in this project. Note that there is no test runner',
        'in this environment, so do not claim the tests pass; run a build to check they compile.',
      ].join('\n'),
  },
  {
    id: 'review',
    label: 'Review changes',
    description: 'Review the uncommitted work for problems.',
    mutates: false,
    unavailable: (scope) =>
      scope.hasChanges ? null : 'There are no uncommitted changes to review.',
    prompt: () =>
      [
        'Review the uncommitted changes in this project.',
        '',
        'Start with get_diff to see exactly what changed, then read the surrounding code for any',
        'hunk you cannot judge from the diff alone, and call get_diagnostics. Look for real',
        'defects: incorrect logic, unhandled errors, security problems, missing cases, and tests',
        'that should exist for this change but do not.',
        '',
        'Report findings with file paths and line numbers, ordered by how much they matter, and',
        'say how confident you are in each. Where the diff does not give you enough context to be',
        'sure, say that instead of guessing. Do not edit anything — this is a review. If the',
        'changes look correct, say so rather than inventing findings.',
      ].join('\n'),
  },
  {
    id: 'optimize',
    label: 'Optimize',
    description: 'Find unnecessary work or complexity.',
    mutates: true,
    unavailable: needsFile,
    prompt: (scope) =>
      [
        target(scope),
        '',
        'Look for unnecessary work here: repeated computation, work in a loop that belongs',
        'outside it, an algorithm doing more than the problem needs. Only change what you can',
        'justify — do not trade clarity for a speed-up you cannot measure. Say plainly when the',
        'code is already fine. Run a build afterwards if you changed anything.',
      ].join('\n'),
  },
  {
    id: 'document',
    label: 'Document',
    description: 'Write documentation for this code.',
    mutates: true,
    unavailable: needsFile,
    prompt: (scope) =>
      [
        target(scope),
        '',
        'Add documentation explaining what this is for and why it works the way it does —',
        'the reasoning a reader cannot recover from the code itself. Do not restate the',
        'signature in prose or comment every line. Match the comment style already used in',
        'this project.',
      ].join('\n'),
  },
];

export function workflowById(id: WorkflowId): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}
