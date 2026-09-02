import { basename, extname } from '@/lib/vfs';

export interface LanguageInfo {
  /** Monaco language id. */
  id: string;
  label: string;
  /** Tailwind text colour class used by the file tree and tabs. */
  color: string;
  /** Short glyph rendered in the file icon chip. */
  glyph: string;
}

/**
 * Registry of supported file types. Adding a language is a one line change
 * here — everything downstream (icons, Monaco mode, search filters) reads it.
 */
const LANGUAGES: Record<string, LanguageInfo> = {
  ts: { id: 'typescript', label: 'TypeScript', color: 'text-sky-400', glyph: 'TS' },
  tsx: { id: 'typescript', label: 'TypeScript JSX', color: 'text-sky-300', glyph: 'TSX' },
  mts: { id: 'typescript', label: 'TypeScript', color: 'text-sky-400', glyph: 'TS' },
  cts: { id: 'typescript', label: 'TypeScript', color: 'text-sky-400', glyph: 'TS' },
  js: { id: 'javascript', label: 'JavaScript', color: 'text-amber-300', glyph: 'JS' },
  jsx: { id: 'javascript', label: 'JavaScript JSX', color: 'text-amber-200', glyph: 'JSX' },
  mjs: { id: 'javascript', label: 'JavaScript', color: 'text-amber-300', glyph: 'JS' },
  cjs: { id: 'javascript', label: 'JavaScript', color: 'text-amber-300', glyph: 'JS' },
  json: { id: 'json', label: 'JSON', color: 'text-yellow-300', glyph: '{}' },
  jsonc: { id: 'json', label: 'JSON', color: 'text-yellow-300', glyph: '{}' },
  html: { id: 'html', label: 'HTML', color: 'text-orange-400', glyph: '<>' },
  htm: { id: 'html', label: 'HTML', color: 'text-orange-400', glyph: '<>' },
  css: { id: 'css', label: 'CSS', color: 'text-blue-400', glyph: '#' },
  scss: { id: 'scss', label: 'SCSS', color: 'text-pink-400', glyph: '#' },
  sass: { id: 'scss', label: 'Sass', color: 'text-pink-400', glyph: '#' },
  less: { id: 'less', label: 'Less', color: 'text-indigo-300', glyph: '#' },
  md: { id: 'markdown', label: 'Markdown', color: 'text-on-surface-variant', glyph: 'MD' },
  mdx: { id: 'markdown', label: 'MDX', color: 'text-on-surface-variant', glyph: 'MD' },
  py: { id: 'python', label: 'Python', color: 'text-emerald-300', glyph: 'PY' },
  java: { id: 'java', label: 'Java', color: 'text-orange-300', glyph: 'JV' },
  cpp: { id: 'cpp', label: 'C++', color: 'text-blue-300', glyph: 'C+' },
  cc: { id: 'cpp', label: 'C++', color: 'text-blue-300', glyph: 'C+' },
  hpp: { id: 'cpp', label: 'C++ Header', color: 'text-blue-300', glyph: 'H' },
  c: { id: 'c', label: 'C', color: 'text-blue-300', glyph: 'C' },
  h: { id: 'c', label: 'C Header', color: 'text-blue-300', glyph: 'H' },
  cs: { id: 'csharp', label: 'C#', color: 'text-violet-300', glyph: 'C#' },
  rs: { id: 'rust', label: 'Rust', color: 'text-orange-400', glyph: 'RS' },
  go: { id: 'go', label: 'Go', color: 'text-cyan-300', glyph: 'GO' },
  rb: { id: 'ruby', label: 'Ruby', color: 'text-red-400', glyph: 'RB' },
  php: { id: 'php', label: 'PHP', color: 'text-indigo-300', glyph: 'PHP' },
  swift: { id: 'swift', label: 'Swift', color: 'text-orange-400', glyph: 'SW' },
  kt: { id: 'kotlin', label: 'Kotlin', color: 'text-violet-300', glyph: 'KT' },
  sql: { id: 'sql', label: 'SQL', color: 'text-teal-300', glyph: 'SQL' },
  yml: { id: 'yaml', label: 'YAML', color: 'text-rose-300', glyph: 'YML' },
  yaml: { id: 'yaml', label: 'YAML', color: 'text-rose-300', glyph: 'YML' },
  xml: { id: 'xml', label: 'XML', color: 'text-orange-300', glyph: 'XML' },
  svg: { id: 'xml', label: 'SVG', color: 'text-fuchsia-300', glyph: 'SVG' },
  sh: { id: 'shell', label: 'Shell', color: 'text-lime-300', glyph: 'SH' },
  bash: { id: 'shell', label: 'Bash', color: 'text-lime-300', glyph: 'SH' },
  zsh: { id: 'shell', label: 'Zsh', color: 'text-lime-300', glyph: 'SH' },
  toml: { id: 'ini', label: 'TOML', color: 'text-stone-300', glyph: 'TML' },
  ini: { id: 'ini', label: 'INI', color: 'text-stone-300', glyph: 'INI' },
  graphql: { id: 'graphql', label: 'GraphQL', color: 'text-pink-400', glyph: 'GQL' },
  gql: { id: 'graphql', label: 'GraphQL', color: 'text-pink-400', glyph: 'GQL' },
  vue: { id: 'html', label: 'Vue', color: 'text-emerald-300', glyph: 'VUE' },
  svelte: { id: 'html', label: 'Svelte', color: 'text-orange-400', glyph: 'SV' },
  txt: { id: 'plaintext', label: 'Plain Text', color: 'text-on-surface-variant', glyph: 'TXT' },
};

const FILENAME_OVERRIDES: Record<string, LanguageInfo> = {
  dockerfile: { id: 'dockerfile', label: 'Dockerfile', color: 'text-sky-300', glyph: 'DK' },
  makefile: { id: 'plaintext', label: 'Makefile', color: 'text-stone-300', glyph: 'MK' },
  '.gitignore': { id: 'plaintext', label: 'Git Ignore', color: 'text-stone-400', glyph: 'GIT' },
  '.env.example': { id: 'shell', label: 'Env Example', color: 'text-yellow-200', glyph: 'ENV' },
};

const FALLBACK: LanguageInfo = {
  id: 'plaintext',
  label: 'Plain Text',
  color: 'text-on-surface-variant',
  glyph: 'F',
};

export function getLanguage(path: string): LanguageInfo {
  const name = basename(path).toLowerCase();
  if (FILENAME_OVERRIDES[name]) return FILENAME_OVERRIDES[name];
  return LANGUAGES[extname(path)] ?? FALLBACK;
}

export function monacoLanguage(path: string): string {
  return getLanguage(path).id;
}

/** Human readable primary language of a project, derived from file counts. */
export function detectProjectLanguage(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const info = LANGUAGES[extname(path)];
    if (!info || info.id === 'plaintext' || info.id === 'markdown' || info.id === 'json') continue;
    counts.set(info.label, (counts.get(info.label) ?? 0) + 1);
  }
  let best = 'Plain Text';
  let max = 0;
  for (const [label, count] of counts) {
    if (count > max) {
      max = count;
      best = label;
    }
  }
  return best;
}

/** Monaco can format these without an external formatter. */
export function canFormat(path: string): boolean {
  return ['typescript', 'javascript', 'json', 'html', 'css', 'scss', 'less'].includes(
    monacoLanguage(path),
  );
}
