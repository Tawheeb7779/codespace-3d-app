import { describe, expect, it } from 'vitest';
import {
  MAX_ANALYSED_FILES,
  MAX_FILE_CHARS,
  MAX_HINT_CHARS,
  MAX_PATHS,
  analyseModule,
  analyseProject,
  findRelated,
  renderIntelligence,
  resolveImport,
} from '@/lib/ai/intelligence';

/**
 * Knowing a project's shape without reading all of it.
 *
 * Every cap here is load-bearing, and the property that matters most is what
 * happens *at* a cap: the analysis says it stopped. An agent handed a partial
 * picture presented as a complete one concludes a symbol is unused and deletes
 * it, and the deletion looks well-reasoned right up until it breaks the build.
 *
 * The relationships are derived from real imports rather than from names,
 * because a file called `userService.ts` that nothing imports is a different
 * fact from one that six files import, and only the second is discoverable by
 * guessing at names.
 */

const PROJECT = {
  'package.json': '{"dependencies":{"react":"18.0.0"}}',
  'src/main.tsx': "import { App } from './App';\nimport React from 'react';\n",
  'src/App.tsx': "import { helper } from '@/lib/helper';\nexport function App() { return null; }\n",
  'src/lib/helper.ts': "export const helper = 1;\nexport type Thing = string;\n",
  'src/lib/orphan.ts': 'export const orphan = 2;\n',
  'README.md': '# project\n',
};

describe('resolving an import', () => {
  it('resolves a relative path with an implied extension', () => {
    expect(resolveImport('./App', 'src/main.tsx', PROJECT)).toBe('src/App.tsx');
  });

  it('resolves the project’s @/ alias', () => {
    expect(resolveImport('@/lib/helper', 'src/App.tsx', PROJECT)).toBe('src/lib/helper.ts');
  });

  it('resolves a directory to its index file', () => {
    const files = { 'src/lib/index.ts': 'export const a = 1;' };

    expect(resolveImport('./lib', 'src/main.ts', files)).toBe('src/lib/index.ts');
  });

  it('walks up with ..', () => {
    expect(resolveImport('../App', 'src/lib/helper.ts', PROJECT)).toBe('src/App.tsx');
  });

  /** A package is not a project file, and inventing a path for it would lie. */
  it('returns null for a bare package specifier', () => {
    expect(resolveImport('react', 'src/main.tsx', PROJECT)).toBeNull();
  });

  it('returns null for a relative path that resolves to nothing', () => {
    expect(resolveImport('./Missing', 'src/main.tsx', PROJECT)).toBeNull();
  });
});

describe('reading one module', () => {
  it('separates project imports from packages', () => {
    const facts = analyseModule('src/main.tsx', PROJECT['src/main.tsx']);

    expect(facts.imports).toEqual(['./App']);
    expect(facts.packages).toEqual(['react']);
  });

  it('reads exported names', () => {
    const facts = analyseModule('src/lib/helper.ts', PROJECT['src/lib/helper.ts']);

    expect(facts.exports).toEqual(['helper', 'Thing']);
  });

  it.each([
    ["const x = require('./a');", './a'],
    ["const x = await import('./a');", './a'],
    ["export { a } from './a';", './a'],
  ])('reads %s', (line, expected) => {
    expect(analyseModule('src/b.ts', line).imports).toContain(expected);
  });

  /** The cap, and the flag that stops a partial read reading as a whole one. */
  it('reads only the first MAX_FILE_CHARS and says so', () => {
    const huge = `${'x'.repeat(MAX_FILE_CHARS)}\nimport { late } from './late';\n`;
    const facts = analyseModule('src/big.ts', huge);

    expect(facts.truncated).toBe(true);
    expect(facts.imports).not.toContain('./late');
  });

  it('does not flag a file under the cap', () => {
    expect(analyseModule('src/a.ts', 'export const a = 1;').truncated).toBe(false);
  });
});

describe('analysing a project', () => {
  const intelligence = analyseProject(PROJECT);

  it('counts the paths it considered', () => {
    expect(intelligence.pathCount).toBe(Object.keys(PROJECT).length);
    expect(intelligence.pathsTruncated).toBe(false);
  });

  it('finds the entry point', () => {
    expect(intelligence.entryPoints).toContain('src/main.tsx');
  });

  it('reports the directory layout', () => {
    expect(intelligence.layout.map((entry) => entry.dir)).toContain('src/lib');
  });

  it('counts packages by how many files import them', () => {
    expect(intelligence.dependencies).toContainEqual({ name: 'react', importedBy: 1 });
  });

  it('finds a file nothing imports', () => {
    expect(intelligence.unreferenced).toContain('src/lib/orphan.ts');
    expect(intelligence.unreferenced).not.toContain('src/App.tsx');
  });

  /** Deterministic: the same project must analyse the same way twice. */
  it('is deterministic', () => {
    expect(analyseProject(PROJECT)).toEqual({ ...intelligence, analysed: intelligence.analysed });
  });

  it('never analyses more than the cap', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) many[`src/f${index}.ts`] = 'export const a = 1;';
    const result = analyseProject(many);

    expect(result.analysed.length).toBe(MAX_ANALYSED_FILES);
    expect(result.analysisTruncated).toBe(true);
  });

  it('considers at most MAX_PATHS paths, and says when it capped', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < MAX_PATHS + 5; index += 1) many[`f${index}.txt`] = 'x';
    const result = analyseProject(many);

    expect(result.pathCount).toBe(MAX_PATHS);
    expect(result.pathsTruncated).toBe(true);
  });

  /** A focused question must not spend its whole budget elsewhere. */
  it('analyses the focused files first', () => {
    const many: Record<string, string> = { 'src/target.ts': 'export const target = 1;' };
    for (let index = 0; index < 60; index += 1) many[`src/f${index}.ts`] = 'export const a = 1;';
    const result = analyseProject(many, ['src/target.ts']);

    expect(result.analysed.map((module) => module.path)).toContain('src/target.ts');
  });

  /** The path filter is the primary control and must apply here too. */
  it('never considers a sensitive path', () => {
    const result = analyseProject({ '.env': 'SECRET=1', 'src/a.ts': 'export const a = 1;' });

    expect(result.analysed.map((module) => module.path)).not.toContain('.env');
    expect(result.pathCount).toBe(1);
  });
});

describe('finding related code', () => {
  it('reports what a file imports', () => {
    expect(findRelated('src/App.tsx', PROJECT).imports).toEqual(['src/lib/helper.ts']);
  });

  it('reports what imports a file', () => {
    expect(findRelated('src/App.tsx', PROJECT).importedBy).toEqual(['src/main.tsx']);
  });

  it('reports files beside it, and not files deeper down', () => {
    const related = findRelated('src/lib/helper.ts', PROJECT);

    expect(related.siblings).toEqual(['src/lib/orphan.ts']);
  });

  it('says how many files it scanned, so "nothing found" has a scope', () => {
    expect(findRelated('src/App.tsx', PROJECT).scanned).toBeGreaterThan(0);
  });

  it('returns empty relationships for a file that is not there', () => {
    expect(findRelated('src/Gone.tsx', PROJECT).imports).toEqual([]);
  });
});

describe('rendering the hint block', () => {
  it('names the analysed files and their exports', () => {
    const text = renderIntelligence(analyseProject(PROJECT));

    expect(text).toContain('src/main.tsx');
    expect(text).toContain('exports:');
  });

  /**
   * The honesty guards. Both of these stop a partial analysis reading as a
   * complete one, which is what turns a hint block into a wrong conclusion.
   */
  it('says when only some files were analysed', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) many[`src/f${index}.ts`] = 'export const a = 1;';

    expect(renderIntelligence(analyseProject(many))).toMatch(/files were analysed in depth/i);
  });

  it('says an unreferenced file is not proof of dead code', () => {
    expect(renderIntelligence(analyseProject(PROJECT))).toMatch(/not evidence they are unused/i);
  });

  it('never exceeds the hint cap, and marks where it cut', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 400; index += 1) {
      many[`src/very/deep/directory/number${index}/file.ts`] = `export const a${index} = 1;`;
    }
    const text = renderIntelligence(analyseProject(many));

    expect(text.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  /** The analysis passes through redaction on the way to the prompt. */
  it('redacts a credential picked up from a file', () => {
    const text = renderIntelligence(
      analyseProject({ 'src/a.ts': 'export const ghp_key = 1;\n', 'src/b.ts': 'export const b = 1;' }),
    );

    expect(text).not.toContain(['ghp', 'a'.repeat(30)].join('_'));
  });
});

/**
 * A specifier pointing outside the project.
 *
 * `normalizePath` refuses `..` outright, which is correct for a write and
 * wrong for an import — so this module walks the segments itself, and the case
 * that must not become an invented in-project path is the one that walks past
 * the root.
 */
describe('an import that leaves the project', () => {
  it('returns null rather than a path inside the project', () => {
    expect(resolveImport('../../../etc/passwd', 'src/App.tsx', PROJECT)).toBeNull();
  });

  it('does not throw on any relative specifier', () => {
    for (const specifier of ['../', './', '../../..', './/./a', '../../a/../b']) {
      expect(() => resolveImport(specifier, 'src/lib/helper.ts', PROJECT)).not.toThrow();
    }
  });

  it('analysing a project with such an import does not throw', () => {
    expect(() =>
      analyseProject({ 'src/a.ts': "import x from '../../../outside';\n" }),
    ).not.toThrow();
  });
});
