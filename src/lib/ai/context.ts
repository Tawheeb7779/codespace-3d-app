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
