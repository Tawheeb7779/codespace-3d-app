import type { SearchMatch } from '@/types';
import { escapeRegExp } from '@/lib/utils';
import { basename } from '@/lib/vfs';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Glob-ish include filter, e.g. `src/**\/*.ts` or `*.css`. */
  include: string;
  exclude: string;
  maxResults: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  maxResults: 500,
};

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

export function buildMatcher(options: SearchOptions): RegExp {
  let source = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
  } catch (error) {
    throw new SearchError(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Translate a simple glob into a RegExp. Supports `*`, `**` and `?`. */
export function globToRegExp(pattern: string): RegExp {
  // Sentinels keep the multi-character globs from being consumed by the
  // single-character rules that follow.
  const GLOBSTAR_SLASH = '\u0000';
  const GLOBSTAR = '\u0001';
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(GLOBSTAR_SLASH)
    .join('(?:.*/)?')
    .split(GLOBSTAR)
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function makeFilter(patterns: string): ((path: string) => boolean) | null {
  const parts = patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const regexes = parts.map((p) => globToRegExp(p.includes('/') ? p : `**/${p}`));
  return (path) => regexes.some((re) => re.test(path) || re.test(`/${path}`));
}

export interface SearchOutcome {
  matches: SearchMatch[];
  filesSearched: number;
  truncated: boolean;
}

/** Search file *contents*. Pure and synchronous so it can run in a worker. */
export function searchContents(
  files: Record<string, string>,
  options: SearchOptions,
): SearchOutcome {
  const matches: SearchMatch[] = [];
  if (!options.query) return { matches, filesSearched: 0, truncated: false };

  const matcher = buildMatcher(options);
  const include = makeFilter(options.include);
  const exclude = makeFilter(options.exclude);
  let filesSearched = 0;

  for (const path of Object.keys(files).sort()) {
    if (include && !include(path)) continue;
    if (exclude && exclude(path)) continue;
    filesSearched += 1;
    const lines = files[path].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      matcher.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = matcher.exec(line)) !== null) {
        if (matches.length >= options.maxResults) return { matches, filesSearched, truncated: true };
        matches.push({
          path,
          line: i + 1,
          column: hit.index + 1,
          preview: line.length > 400 ? `${line.slice(0, 400)}…` : line,
          matchStart: hit.index,
          matchEnd: hit.index + hit[0].length,
        });
        // Zero-length matches (e.g. `a*`) would loop forever otherwise.
        if (hit[0].length === 0) matcher.lastIndex += 1;
      }
    }
  }
  return { matches, filesSearched, truncated: false };
}

/** Fuzzy filename match used by the command palette's file picker. */
export function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 1;
  const lowerNeedle = needle.toLowerCase();
  const lowerHay = haystack.toLowerCase();
  const direct = lowerHay.indexOf(lowerNeedle);
  if (direct !== -1) {
    // Exact substring wins, and matches in the basename win harder.
    const inBase = basename(lowerHay).includes(lowerNeedle) ? 0.3 : 0;
    return 1 + inBase - direct / (lowerHay.length * 4);
  }
  let score = 0;
  let index = 0;
  let streak = 0;
  for (const char of lowerNeedle) {
    const found = lowerHay.indexOf(char, index);
    if (found === -1) return 0;
    streak = found === index ? streak + 1 : 0;
    score += 1 + streak * 0.4;
    index = found + 1;
  }
  return score / (lowerNeedle.length * 3);
}

export function rankPaths(paths: string[], query: string, limit = 40): string[] {
  if (!query.trim()) return paths.slice(0, limit);
  return paths
    .map((path) => ({ path, score: fuzzyScore(query.trim(), path) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** Replace every match across the given files, returning only changed files. */
export function replaceAll(
  files: Record<string, string>,
  options: SearchOptions,
  replacement: string,
  onlyPaths?: string[],
): { files: Record<string, string>; changed: string[]; replacements: number } {
  const matcher = buildMatcher(options);
  const include = makeFilter(options.include);
  const exclude = makeFilter(options.exclude);
  const limitTo = onlyPaths ? new Set(onlyPaths) : null;
  const next: Record<string, string> = {};
  const changed: string[] = [];
  let replacements = 0;

  for (const [path, content] of Object.entries(files)) {
    if (limitTo && !limitTo.has(path)) continue;
    if (include && !include(path)) continue;
    if (exclude && exclude(path)) continue;
    matcher.lastIndex = 0;
    const count = content.match(matcher)?.length ?? 0;
    if (!count) continue;
    matcher.lastIndex = 0;
    // Literal searches must not interpret `$1` in the replacement.
    const updated = options.regex
      ? content.replace(matcher, replacement)
      : content.replace(matcher, () => replacement);
    next[path] = updated;
    changed.push(path);
    replacements += count;
  }
  return { files: next, changed, replacements };
}
