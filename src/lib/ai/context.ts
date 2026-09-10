import { hashContent } from '@/lib/vcs';

/**
 * What the agent is told about the project, and what it is not told twice.
 *
 * Two rules drive this. The agent gets a small, factual header rather than the
 * repository — a project of any size would otherwise cost more in tokens than
 * the task is worth. And a file it has already read is not resent verbatim
 * while it is unchanged: the second read returns a short note instead, which
 * is what stops a long task from paying for the same file five times.
 */

export interface ProjectContext {
  name: string;
  template: string;
  language: string;
  /** Detected from the manifest, not guessed from file extensions. */
  framework: string;
  packageManager: string;
  branch: string;
  /** Paths with uncommitted changes, capped. */
  dirty: string[];
  /** Open problems from the editor, capped and summarised. */
  diagnostics: string[];
  fileCount: number;
  /** A shallow listing: top-level entries plus notable config files. */
  outline: string[];
  /**
   * The terminals that are actually open, and which environment each is in.
   *
   * The agent has to be told, because the three environments are different
   * machines and only one of them is reachable from `run_command`. Without
   * this it writes a Linux command expecting the Linux Terminal to run it,
   * gets the in-browser shell's refusal, and reads that as a project fault.
   * Omitted from the header entirely when nothing is open.
   */
  terminals?: Array<{ name: string; environment: string; label: string }>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

/** Read the framework and package manager out of package.json, if there is one. */
export function detectStack(files: Record<string, string>): {
  framework: string;
  packageManager: string;
} {
  const raw = files['package.json'];
  if (!raw) return { framework: 'none', packageManager: 'none' };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    return { framework: 'unknown (package.json is not valid JSON)', packageManager: 'unknown' };
  }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const framework = deps.next
    ? 'next'
    : deps.react
      ? 'react'
      : deps.vue
        ? 'vue'
        : deps.svelte
          ? 'svelte'
          : 'none';
  const packageManager = manifest.packageManager?.split('@')[0] ?? (files['pnpm-lock.yaml'] ? 'pnpm' : 'npm');
  return { framework, packageManager };
}

const NOTABLE = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'index.html',
  'README.md',
];

/**
 * A shallow map: every top-level entry, plus config files wherever they sit.
 * Enough for the agent to know where to look without reading anything.
 */
export function outlineOf(files: Record<string, string>, limit = 60): string[] {
  const top = new Set<string>();
  for (const path of Object.keys(files)) {
    const slash = path.indexOf('/');
    top.add(slash === -1 ? path : `${path.slice(0, slash)}/`);
  }
  const notable = NOTABLE.filter((path) => path in files);
  return [...new Set([...notable, ...[...top].sort()])].slice(0, limit);
}

/** Render the header the model sees. Short by construction. */
export function renderContext(context: ProjectContext): string {
  const lines = [
    `Project: ${context.name}`,
    `Template: ${context.template}  Language: ${context.language}  Framework: ${context.framework}`,
    `Package manager: ${context.packageManager}  Branch: ${context.branch}  Files: ${context.fileCount}`,
    `Layout: ${context.outline.join(' ')}`,
  ];
  if (context.terminals?.length) {
    lines.push('Terminals open:');
    for (const terminal of context.terminals.slice(0, 8)) {
      lines.push(`  "${terminal.name}" — ${terminal.label} (environment: ${terminal.environment})`);
    }
    lines.push(
      '  run_command runs only in the Project Terminal (in-browser). It cannot run in a ' +
        'container or in the Linux Terminal. get_terminal_output takes an environment.',
    );
  }
  if (context.dirty.length) {
    lines.push(`Uncommitted: ${context.dirty.slice(0, 12).join(' ')}`);
  }
  if (context.diagnostics.length) {
    lines.push('Current problems:');
    for (const problem of context.diagnostics.slice(0, 10)) lines.push(`  ${problem}`);
  }
  return lines.join('\n');
}

/**
 * Remembers what the agent has already been shown.
 *
 * Keyed by content hash, so a file that changed since the last read is sent
 * again in full — the saving must never cost correctness.
 */
export class ReadCache {
  private seen = new Map<string, string>();
  private savedBytes = 0;

  /**
   * Returns the text to hand the model for this file: the content on a first
   * read or after a change, and a short note when it is already in context.
   */
  record(path: string, content: string): { text: string; cached: boolean } {
    const hash = hashContent(content);
    if (this.seen.get(path) === hash) {
      this.savedBytes += content.length;
      return {
        text: `(${path} is unchanged since you read it earlier in this task — use what you already have)`,
        cached: true,
      };
    }
    this.seen.set(path, hash);
    return { text: content, cached: false };
  }

  /**
   * Has this file changed since the agent was shown it?
   *
   * A whole-file overwrite carries no anchor, so nothing else can notice that
   * the user edited the file while the agent was working — it would simply
   * replace their work. This is the check that notices.
   *
   * False for a file the agent has not read: it is not working from a stale
   * copy if it never had a copy, and refusing there would block legitimate
   * file creation.
   */
  isStale(path: string, content: string): boolean {
    const seen = this.seen.get(path);
    return seen !== undefined && seen !== hashContent(content);
  }

  /** Drop a path so the next read resends it — used after the agent edits. */
  invalidate(path: string): void {
    this.seen.delete(path);
  }

  clear(): void {
    this.seen.clear();
    this.savedBytes = 0;
  }

  get stats(): { files: number; savedBytes: number } {
    return { files: this.seen.size, savedBytes: this.savedBytes };
  }
}
