/**
 * Virtual file system helpers.
 *
 * Every path that enters the workspace — from the UI, a ZIP import, the shell,
 * or an AI tool call — goes through {@link normalizePath}. It is the single
 * choke point that prevents traversal out of the project root.
 */

export class VfsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VfsError';
  }
}

/** Windows reserved device names, rejected so exports stay portable. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Control characters and characters that are illegal in Windows paths. The
// control-character range is deliberate: it is what we are screening out.
// eslint-disable-next-line no-control-regex
const ILLEGAL_SEGMENT = /[\x00-\x1f<>:"|?*]/;

export const MAX_PATH_LENGTH = 400;
export const MAX_SEGMENTS = 32;

/**
 * Normalize an arbitrary user supplied path into a project relative POSIX path.
 *
 * Throws {@link VfsError} for anything that would escape the project root,
 * rather than silently clamping, so callers surface a real error to the user.
 */
export function normalizePath(input: string): string {
  if (typeof input !== 'string') throw new VfsError('Path must be a string');
  let raw = input.trim();
  if (!raw) throw new VfsError('Path is empty');
  if (raw.length > MAX_PATH_LENGTH) {
    throw new VfsError(`Path exceeds ${MAX_PATH_LENGTH} characters`);
  }
  // Treat backslashes as separators so Windows-style input cannot smuggle
  // a `..\` segment past the checks below.
  raw = raw.replace(/\\/g, '/');
  // A leading slash is accepted and interpreted as "project root".
  raw = raw.replace(/^\/+/, '');

  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Refuse instead of popping: a request to leave the root is a bug or an
      // attack, never a legitimate edit inside the workspace.
      throw new VfsError(`Path escapes the project root: ${input}`);
    }
    if (ILLEGAL_SEGMENT.test(segment)) {
      throw new VfsError(`Path contains illegal characters: ${segment}`);
    }
    if (RESERVED.test(segment)) {
      throw new VfsError(`"${segment}" is a reserved name`);
    }
    if (segment.length > 128) throw new VfsError('Path segment is too long');
    out.push(segment);
  }
  if (!out.length) throw new VfsError('Path resolves to the project root');
  if (out.length > MAX_SEGMENTS) throw new VfsError('Path is nested too deeply');
  return out.join('/');
}

/**
 * Resolve a specifier against a directory, collapsing `..` as it goes.
 *
 * {@link normalizePath} rejects `..` outright, which is right for a stored
 * path but wrong for a *relative reference*: `../shared` from `src/lib` is an
 * ordinary import. This walks the segments instead, and still refuses to pop
 * past the project root, so traversal remains impossible.
 */
export function resolveRelative(baseDir: string, spec: string): string {
  if (typeof spec !== 'string') throw new VfsError('Path must be a string');
  const normalizedSpec = spec.replace(/\\/g, '/');
  // A leading slash means "from the project root", not "from the filesystem".
  const parts = normalizedSpec.startsWith('/') || !baseDir ? [] : baseDir.split('/');
  for (const segment of normalizedSpec.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new VfsError(`Path escapes the project root: ${spec}`);
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (!parts.length) throw new VfsError(`Path resolves to the project root: ${spec}`);
  return normalizePath(parts.join('/'));
}

/** `true` when `path` is safe; never throws. */
export function isValidPath(path: string): boolean {
  try {
    normalizePath(path);
    return true;
  } catch {
    return false;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

/** All ancestor directories of a path, shallowest first. */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join('/'));
  return out;
}

export function isDescendant(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: TreeNode[];
}

/**
 * Build a sorted tree (directories first, then case-insensitive name order)
 * from the flat file map plus explicit directory entries.
 */
export function buildTree(files: Record<string, string>, dirs: string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const dirIndex = new Map<string, TreeNode>([['', root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirIndex.get(path);
    if (existing) return existing;
    const parent = ensureDir(dirname(path));
    const node: TreeNode = { name: basename(path), path, type: 'dir', children: [] };
    parent.children.push(node);
    dirIndex.set(path, node);
    return node;
  };

  for (const dir of dirs) {
    if (dir) ensureDir(dir);
  }
  for (const path of Object.keys(files)) {
    const parent = ensureDir(dirname(path));
    parent.children.push({ name: basename(path), path, type: 'file', children: [] });
  }

  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Flatten a tree honouring the set of expanded directories. */
export function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
): Array<TreeNode & { depth: number }> {
  const out: Array<TreeNode & { depth: number }> = [];
  for (const node of nodes) {
    out.push({ ...node, depth });
    if (node.type === 'dir' && expanded.has(node.path)) {
      out.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sensitive path policy (import/export)
// ---------------------------------------------------------------------------

/**
 * Paths that must never be written by an import or emitted by an export:
 * VCS internals, dependency caches, build output and anything holding secrets.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  // Any .env file, except the conventional secret-free samples.
  /(^|\/)\.env(?!\.(example|sample|template)(\.|$))($|\..*$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)__MACOSX(\/|$)/,
  /(^|\/)(dist|build|\.next|\.cache|coverage)(\/|$)/,
];

export function isSensitivePath(path: string): boolean {
  return BLOCKED_PATTERNS.some((re) => re.test(path));
}

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'html', 'htm', 'css', 'scss', 'sass',
  'less', 'md', 'mdx', 'txt', 'yml', 'yaml', 'xml', 'svg', 'toml', 'ini', 'cfg', 'conf', 'env',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'sql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'dockerfile', 'gitignore', 'graphql', 'gql', 'vue',
  'svelte', 'astro', 'lock', 'properties', 'csv', 'tsv',
]);

/** Heuristic: can this file be opened in the text editor at all? */
export function isTextFile(path: string): boolean {
  const ext = extname(path);
  if (!ext) return /^(dockerfile|makefile|readme|license|changelog|procfile)$/i.test(basename(path));
  return TEXT_EXTENSIONS.has(ext);
}
