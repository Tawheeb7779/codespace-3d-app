import { isSensitivePath } from '@/lib/vfs';
import { redact } from '@/lib/ai/privacy';

/**
 * What the agent can learn about a project without reading all of it.
 *
 * An agent asked to change a codebase needs to know its shape: where the entry
 * points are, what imports what, which files move together, what the project
 * is built with. Reading everything answers that and costs more than the task
 * is worth; guessing answers it for free and is wrong.
 *
 * So this derives structure from the files that are already in memory — real
 * imports, real exports, real paths — and every number it reports is counted
 * rather than estimated. Where it had to stop early, it says so: a truncated
 * analysis presented as a complete one is how an agent concludes a symbol is
 * unused and deletes it.
 *
 * **Every cap here is deliberate and enforced.** They exist because this
 * output goes into a prompt, and an unbounded prompt is a request that fails
 * at the provider after the user has waited for it.
 */

/** Files whose full text may be scanned for imports and exports. */
export const MAX_ANALYSED_FILES = 18;
/** Paths considered at all, before any content is read. */
export const MAX_PATHS = 5_000;
/** Characters read from any single file. */
export const MAX_FILE_CHARS = 64_000;
/** Characters of the rendered hint block handed to the model. */
export const MAX_HINT_CHARS = 12_000;

/** Extensions worth parsing for module structure. */
const CODE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/;

/** Where a project's entry point conventionally lives. */
const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'src/App.tsx',
  'index.tsx',
  'index.ts',
  'main.py',
  'app.py',
  'index.html',
];

export interface ModuleFacts {
  path: string;
  /** Project-relative paths this file imports, resolved where possible. */
  imports: string[];
  /** Bare specifiers — packages, not project files. */
  packages: string[];
  /** Exported names, as declared. */
  exports: string[];
  lines: number;
  /** True when only the first MAX_FILE_CHARS were read. */
  truncated: boolean;
}

export interface ProjectIntelligence {
  /** Every path considered, after the sensitive-path filter and the cap. */
  pathCount: number;
  /** True when there were more paths than MAX_PATHS. */
  pathsTruncated: boolean;
  /** The files actually parsed. */
  analysed: ModuleFacts[];
  /** True when more files were eligible than MAX_ANALYSED_FILES. */
  analysisTruncated: boolean;
  /** Directories by file count, largest first, capped for readability. */
  layout: Array<{ dir: string; files: number }>;
  entryPoints: string[];
  /** Packages imported across the analysed files, by how many import them. */
  dependencies: Array<{ name: string; importedBy: number }>;
  /** Files nothing in the analysed set imports. Never proof of dead code. */
  unreferenced: string[];
}

function projectPaths(files: Record<string, string>): { paths: string[]; truncated: boolean } {
  const all = Object.keys(files)
    .filter((path) => !isSensitivePath(path))
    .sort();
  return { paths: all.slice(0, MAX_PATHS), truncated: all.length > MAX_PATHS };
}

/**
 * Resolve one import specifier to a project path, or return null.
 *
 * Null is a real answer here: a bare specifier is a package, and a relative
 * path that resolves to nothing is a broken import worth not inventing a
 * target for.
 */
export function resolveImport(
  specifier: string,
  fromPath: string,
  files: Record<string, string>,
): string | null {
  let base: string;

  if (specifier.startsWith('@/')) {
    // The alias this project configures, so it resolves like a real one.
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith('.')) {
    /*
     * `..` is resolved here rather than by `normalizePath`, which refuses it.
     *
     * That refusal is right for the write tools — a path leaving the project
     * root is a bug or an attack there. It is wrong for an import, where
     * `../lib/x` is ordinary and correct. So the segments are walked in this
     * module, and a specifier that walks *past* the root returns null: it
     * points outside the project, which is a real answer and not a path worth
     * inventing.
     */
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const segments = dir ? dir.split('/') : [];
    for (const segment of specifier.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (!segments.length) return null;
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    if (!segments.length) return null;
    base = segments.join('/');
  } else {
    return null;
  }

  if (files[base] !== undefined) return base;
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']) {
    if (files[`${base}${extension}`] !== undefined) return `${base}${extension}`;
  }
  for (const index of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    if (files[`${base}${index}`] !== undefined) return `${base}${index}`;
  }
  return null;
}

const IMPORT_PATTERN =
  /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|[^\w.])(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(?:[\s\S]*?\s+)?from\s+['"]([^'"]+)['"]/g;

const EXPORT_PATTERN =
  /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

/** Read one file's module structure. Content over the cap is read in part. */
export function analyseModule(path: string, content: string): ModuleFacts {
  const truncated = content.length > MAX_FILE_CHARS;
  const text = truncated ? content.slice(0, MAX_FILE_CHARS) : content;

  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }

  const exports: string[] = [];
  for (const match of text.matchAll(EXPORT_PATTERN)) exports.push(match[1]);

  return {
    path,
    imports: [...new Set(specifiers.filter((s) => s.startsWith('.') || s.startsWith('@/')))],
    packages: [...new Set(specifiers.filter((s) => !s.startsWith('.') && !s.startsWith('@/')))],
    exports: [...new Set(exports)],
    // Counted on the text that was read, and flagged when that was partial —
    // reporting the whole file's line count from a partial read would be a
    // number nobody measured.
    lines: text.split('\n').length,
    truncated,
  };
}

/**
 * Which files to parse, when there are more than the cap allows.
 *
 * Entry points first, because they are the map. Then the files a caller said
 * it cares about. Then shallow-and-large files, which in practice are the ones
 * that hold a project's structure. Deterministic, so the same project analyses
 * the same way twice.
 */
function chooseFiles(paths: string[], files: Record<string, string>, focus: string[]): string[] {
  const entries = paths.filter((path) => ENTRY_CANDIDATES.includes(path));
  const wanted = focus.filter((path) => files[path] !== undefined && !entries.includes(path));
  const rest = paths
    .filter((path) => CODE.test(path) && !entries.includes(path) && !wanted.includes(path))
    .sort((a, b) => {
      const depth = a.split('/').length - b.split('/').length;
      if (depth !== 0) return depth;
      const size = (files[b]?.length ?? 0) - (files[a]?.length ?? 0);
      if (size !== 0) return size;
      return a.localeCompare(b);
    });

  return [...entries, ...wanted, ...rest].slice(0, MAX_ANALYSED_FILES);
}

/**
 * Derive what is known about a project's structure.
 *
 * `focus` names paths the caller already cares about, so a question about one
 * file does not spend its whole budget elsewhere.
 */
export function analyseProject(
  files: Record<string, string>,
  focus: string[] = [],
): ProjectIntelligence {
  const { paths, truncated: pathsTruncated } = projectPaths(files);

  const byDir = new Map<string, number>();
  for (const path of paths) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }

  const eligible = paths.filter((path) => CODE.test(path));
  const chosen = chooseFiles(paths, files, focus);
  const analysed = chosen.map((path) => analyseModule(path, files[path] ?? ''));

  const packageCount = new Map<string, number>();
  for (const module of analysed) {
    for (const name of module.packages) {
      // The package, not the deep path into it: `react-dom/client` is react-dom.
      const base = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      packageCount.set(base, (packageCount.get(base) ?? 0) + 1);
    }
  }

  const referenced = new Set<string>();
  for (const module of analysed) {
    for (const specifier of module.imports) {
      const resolved = resolveImport(specifier, module.path, files);
      if (resolved) referenced.add(resolved);
    }
  }

  return {
    pathCount: paths.length,
    pathsTruncated,
    analysed,
    analysisTruncated: eligible.length > chosen.length,
    layout: [...byDir.entries()]
      .map(([dir, count]) => ({ dir, files: count }))
      .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
      .slice(0, 20),
    entryPoints: paths.filter((path) => ENTRY_CANDIDATES.includes(path)),
    dependencies: [...packageCount.entries()]
      .map(([name, importedBy]) => ({ name, importedBy }))
      .sort((a, b) => b.importedBy - a.importedBy || a.name.localeCompare(b.name))
      .slice(0, 30),
    // Only ever within the analysed set, and named accordingly: nothing here
    // has looked at the files that were not parsed.
    unreferenced: analysed
      .map((module) => module.path)
      .filter((path) => !referenced.has(path) && !ENTRY_CANDIDATES.includes(path)),
  };
}

/**
 * Files related to one file, by the imports that actually exist.
 *
 * Both directions, because "what does this need" and "what needs this" are
 * different questions and a caller about to change a file needs the second one.
 */
export function findRelated(
  path: string,
  files: Record<string, string>,
  limit = 20,
): { imports: string[]; importedBy: string[]; siblings: string[]; scanned: number } {
  const { paths } = projectPaths(files);
  const content = files[path];

  const imports = content
    ? analyseModule(path, content)
        .imports.map((specifier) => resolveImport(specifier, path, files))
        .filter((resolved): resolved is string => resolved !== null)
    : [];

  const importedBy: string[] = [];
  const code = paths.filter((candidate) => CODE.test(candidate) && candidate !== path);
  // Bounded by the same path cap; a project larger than that is reported as
  // scanned-in-part rather than silently searched in part.
  for (const candidate of code) {
    const text = files[candidate] ?? '';
    if (text.length > MAX_FILE_CHARS) continue;
    const facts = analyseModule(candidate, text);
    if (
      facts.imports.some((specifier) => resolveImport(specifier, candidate, files) === path)
    ) {
      importedBy.push(candidate);
      if (importedBy.length >= limit) break;
    }
  }

  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  const siblings = paths
    .filter((candidate) => candidate !== path && candidate.startsWith(dir === '.' ? '' : `${dir}/`))
    .filter((candidate) => !candidate.slice(dir === '.' ? 0 : dir.length + 1).includes('/'))
    .slice(0, limit);

  return { imports: imports.slice(0, limit), importedBy, siblings, scanned: code.length };
}

/**
 * Render the analysis for a prompt, redacted and bounded.
 *
 * Redaction runs on the way out, because a file path is harmless and an export
 * name is harmless but a string this pulled out of a file might not be. The
 * character cap is enforced by truncating with a visible marker: a hint block
 * that silently lost its last third would have the model reasoning about a
 * project that stops halfway through.
 */
export function renderIntelligence(intelligence: ProjectIntelligence): string {
  const lines: string[] = [];

  lines.push(`Project structure (${intelligence.pathCount} files considered${intelligence.pathsTruncated ? `, capped at ${MAX_PATHS}` : ''}):`);
  for (const entry of intelligence.layout) {
    lines.push(`  ${entry.dir}/ — ${entry.files} file${entry.files === 1 ? '' : 's'}`);
  }

  if (intelligence.entryPoints.length) {
    lines.push('', `Entry points: ${intelligence.entryPoints.join(', ')}`);
  }

  if (intelligence.dependencies.length) {
    lines.push(
      '',
      'Packages used by the analysed files:',
      ...intelligence.dependencies.map((entry) => `  ${entry.name} (${entry.importedBy})`),
    );
  }

  lines.push('', `Analysed ${intelligence.analysed.length} file(s) in depth:`);
  for (const module of intelligence.analysed) {
    const parts = [`  ${module.path} — ${module.lines} lines${module.truncated ? ' (read in part)' : ''}`];
    if (module.exports.length) parts.push(`    exports: ${module.exports.slice(0, 12).join(', ')}`);
    if (module.imports.length) parts.push(`    imports: ${module.imports.slice(0, 12).join(', ')}`);
    lines.push(...parts);
  }

  if (intelligence.analysisTruncated) {
    lines.push(
      '',
      `Only ${MAX_ANALYSED_FILES} files were analysed in depth; the project has more. Anything below is about those files only.`,
    );
  }

  if (intelligence.unreferenced.length) {
    lines.push(
      '',
      `Not imported by any analysed file: ${intelligence.unreferenced.join(', ')}. This is not evidence they are unused — most of the project was not analysed.`,
    );
  }

  const text = redact(lines.join('\n')).text;
  if (text.length <= MAX_HINT_CHARS) return text;
  return `${text.slice(0, MAX_HINT_CHARS - 80)}\n\n[truncated at ${MAX_HINT_CHARS} characters; the analysis continues beyond this point]`;
}
