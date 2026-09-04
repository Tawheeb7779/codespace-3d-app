import { isSensitivePath, readableFiles } from '@/lib/vfs';

/**
 * What the model is allowed to be told, and what the user chose to tell it.
 *
 * Two separate questions, deliberately kept apart. The security model decides
 * what *may* be sent — protected paths never can be, whatever anyone selects.
 * These toggles decide what *is* sent out of the remainder, so the user can
 * keep a turn cheap and focused without ever being able to widen the boundary.
 *
 * Every source here is opt-in-shaped: turning one on adds material to the
 * header the agent receives on the first turn. None of them can add a file the
 * policy excludes, because the file map is filtered before it is read.
 */

export type ContextSource =
  | 'currentFile'
  | 'selection'
  | 'openFiles'
  | 'projectOutline'
  | 'diagnostics'
  | 'gitDiff'
  | 'terminal';

export interface ContextChoices {
  currentFile: boolean;
  selection: boolean;
  openFiles: boolean;
  projectOutline: boolean;
  diagnostics: boolean;
  gitDiff: boolean;
  terminal: boolean;
}

/**
 * Sensible defaults: enough to answer a question about the code in front of
 * you, without shipping the terminal buffer or a whole diff on every turn.
 */
export const DEFAULT_CONTEXT: ContextChoices = {
  currentFile: true,
  selection: true,
  openFiles: false,
  projectOutline: true,
  diagnostics: true,
  gitDiff: false,
  terminal: false,
};

export const CONTEXT_LABELS: Record<ContextSource, string> = {
  currentFile: 'Current file',
  selection: 'Selected code',
  openFiles: 'Open files',
  projectOutline: 'Project structure',
  diagnostics: 'Problems',
  gitDiff: 'Uncommitted changes',
  terminal: 'Terminal output',
};

export const CONTEXT_DESCRIPTIONS: Record<ContextSource, string> = {
  currentFile: 'The path of the file you have open. The agent reads it with a tool when it needs to.',
  selection: 'The exact text you have selected, quoted into the request.',
  openFiles: 'The paths of every open tab, so the agent knows what you are working across.',
  projectOutline: 'A shallow map of the project layout — directories and notable files.',
  diagnostics: 'Errors and warnings currently reported by the editor.',
  gitDiff: 'Which files have uncommitted changes, and how large the change is.',
  terminal: 'Recent output from the terminal.',
};

/** Truncation limits, so one source cannot crowd out the actual question. */
const LIMITS = {
  selection: 4000,
  terminal: 2000,
  openFiles: 40,
  diagnostics: 20,
  gitDiff: 40,
} as const;

export interface ContextInputs {
  currentPath: string | null;
  selection: string;
  openPaths: string[];
  files: Record<string, string>;
  diagnostics: string[];
  /** Paths with uncommitted changes. */
  changedPaths: string[];
  terminalOutput: string;
}

export interface ContextSection {
  source: ContextSource;
  title: string;
  body: string;
  /** Rough size, so the panel can show what a turn costs. */
  characters: number;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

/**
 * Build the sections the user asked for, dropping anything protected.
 *
 * Paths are filtered rather than merely skipped when read: a protected path
 * must not appear even as a *name*, since a file list is itself a disclosure
 * of what exists.
 */
export function buildContextSections(
  choices: ContextChoices,
  inputs: ContextInputs,
): ContextSection[] {
  const visible = readableFiles(inputs.files);
  const allowed = (path: string) => path in visible && !isSensitivePath(path);
  const sections: ContextSection[] = [];

  const add = (source: ContextSource, title: string, body: string) => {
    const trimmed = body.trim();
    if (trimmed) sections.push({ source, title, body: trimmed, characters: trimmed.length });
  };

  if (choices.currentFile && inputs.currentPath && allowed(inputs.currentPath)) {
    add('currentFile', 'Current file', inputs.currentPath);
  }

  if (choices.selection && inputs.selection.trim()) {
    add('selection', 'Selected code', clip(inputs.selection, LIMITS.selection));
  }

  if (choices.openFiles) {
    const paths = inputs.openPaths.filter(allowed).slice(0, LIMITS.openFiles);
    add('openFiles', 'Open files', paths.join('\n'));
  }

  if (choices.diagnostics) {
    add('diagnostics', 'Problems', inputs.diagnostics.slice(0, LIMITS.diagnostics).join('\n'));
  }

  if (choices.gitDiff) {
    const changed = inputs.changedPaths.filter(allowed).slice(0, LIMITS.gitDiff);
    add('gitDiff', 'Uncommitted changes', changed.join('\n'));
  }

  if (choices.terminal) {
    add('terminal', 'Recent terminal output', clip(inputs.terminalOutput, LIMITS.terminal));
  }

  return sections;
}

/** Render the chosen sections as one block appended to the project header. */
export function renderContextSections(sections: ContextSection[]): string {
  if (!sections.length) return '';
  return sections.map((section) => `## ${section.title}\n${section.body}`).join('\n\n');
}

/** Total size of what a turn will send, for the panel's estimate. */
export function contextSize(sections: ContextSection[]): number {
  return sections.reduce((total, section) => total + section.characters, 0);
}
