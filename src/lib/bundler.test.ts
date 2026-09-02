// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { createVfsPlugin, isBareSpecifier } from '@/lib/bundler';
import { EMPTY_RUNTIME, type PreviewRuntime } from '@/lib/previewRuntime';

/**
 * Resolution rules for the preview bundler, exercised against a real esbuild.
 *
 * The browser uses esbuild-wasm; this uses the native build. The plugin API is
 * the same, so these tests catch resolution regressions — the class of bug that
 * produces a silently blank preview — without loading a 9 MB wasm binary.
 */

interface Outcome {
  js: string;
  errors: string[];
  externals: string[];
  bundledPackages: string[];
}

async function compile(
  files: Record<string, string>,
  entry: string,
  runtime: PreviewRuntime = EMPTY_RUNTIME,
): Promise<Outcome> {
  const record = { externals: new Set<string>(), bundledPackages: new Set<string>() };
  const plugin = createVfsPlugin(files, entry, runtime, record) as unknown as Plugin;
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2020',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'react',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [plugin],
      outdir: 'out',
    });
    return {
      js: (result.outputFiles ?? []).map((f) => f.text).join('\n'),
      errors: result.errors.map((e) => e.text),
      externals: [...record.externals],
      bundledPackages: [...record.bundledPackages],
    };
  } catch (error) {
    const failure = error as { errors?: Array<{ text: string }> };
    return {
      js: '',
      errors: (failure.errors ?? [{ text: String(error) }]).map((e) => e.text),
      externals: [...record.externals],
      bundledPackages: [...record.bundledPackages],
    };
  }
}

/** A stand-in runtime with the same shape the generated one has. */
const fakeRuntime: PreviewRuntime = {
  react: '18.3.1',
  packages: {
    react: 'react.js',
    'react/jsx-runtime': 'jsx-runtime.js',
  },
  sources: {
    'react.js': `export * from "./chunk-shared.js";\nexport { createElement } from "./chunk-shared.js";\nexport default { marker: "local-react" };\n`,
    'jsx-runtime.js': `export { jsx, jsxs, Fragment } from "./chunk-shared.js";\n`,
    // Every export reads the shared value so nothing is tree-shaken away and
    // the "appears exactly once" assertion is meaningful.
    'chunk-shared.js':
      `const SHARED = "single-instance";\n` +
      `export const createElement = () => SHARED;\n` +
      `export const jsx = () => SHARED;\n` +
      `export const jsxs = jsx;\n` +
      `export const Fragment = Symbol.for(SHARED);\n`,
  },
};

describe('relative resolution', () => {
  it('resolves an extensionless sibling import', async () => {
    const result = await compile(
      { 'src/main.ts': `import { v } from './helper';\nconsole.log(v);\n`, 'src/helper.ts': 'export const v = 1;' },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.js).toContain('v = 1');
  });

  it('resolves a directory index file', async () => {
    const result = await compile(
      {
        'src/main.ts': `import { v } from './lib';\nconsole.log(v);\n`,
        'src/lib/index.ts': 'export const v = 42;',
      },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.js).toContain('42');
  });

  it('walks up through parent directories', async () => {
    const result = await compile(
      {
        'src/deep/nested/main.ts': `import { v } from '../../shared';\nconsole.log(v);\n`,
        'src/shared.ts': 'export const v = "up-two";',
      },
      'src/deep/nested/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.js).toContain('up-two');
  });

  it('follows a re-export chain', async () => {
    const result = await compile(
      {
        'src/main.ts': `import { deep } from './barrel';\nconsole.log(deep);\n`,
        'src/barrel.ts': `export { deep } from './modules/deep';`,
        'src/modules/deep.ts': 'export const deep = "reached";',
      },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.js).toContain('reached');
  });

  it('treats a root-absolute specifier as project relative', async () => {
    const result = await compile(
      { 'src/main.ts': `import { v } from '/src/x';\nconsole.log(v);`, 'src/x.ts': 'export const v = 9;' },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
  });

  it('names the file and importer when a relative import is missing', async () => {
    const result = await compile({ 'src/main.ts': `import './nope';` }, 'src/main.ts');
    expect(result.errors.join(' ')).toMatch(/Cannot resolve "\.\/nope" from "src\/main\.ts"/);
  });

  // A traversing specifier must not reach outside the project, and must not
  // crash the build either.
  it('refuses a specifier that escapes the project root', async () => {
    const result = await compile(
      { 'src/main.ts': `import '../../../etc/passwd';` },
      'src/main.ts',
    );
    expect(result.errors.join(' ')).toMatch(/Cannot resolve/);
    expect(result.js).toBe('');
  });
});

describe('asset imports', () => {
  it('inlines a CSS import into the css output', async () => {
    const result = await compile(
      { 'src/main.ts': `import './a.css';`, 'src/a.css': '.probe { color: rgb(1, 2, 3); }' },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
  });

  it('parses a JSON import into a real value', async () => {
    const result = await compile(
      {
        'src/main.ts': `import data from './data.json';\nconsole.log(data.label);`,
        'src/data.json': '{ "label": "from-json" }',
      },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.js).toContain('from-json');
  });

  it('reports malformed JSON with a location', async () => {
    const result = await compile(
      { 'src/main.ts': `import d from './bad.json';\nconsole.log(d);`, 'src/bad.json': '{ nope' },
      'src/main.ts',
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('package resolution', () => {
  it('leaves an unknown bare import external', async () => {
    const result = await compile(
      { 'src/main.ts': `import c from 'canvas-confetti';\nconsole.log(c);` },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.externals).toEqual(['canvas-confetti']);
    expect(result.bundledPackages).toEqual([]);
    expect(result.js).toContain('from "canvas-confetti"');
  });

  it('compiles a known package in from the local runtime', async () => {
    const result = await compile(
      { 'src/main.ts': `import React from 'react';\nconsole.log(React.marker);` },
      'src/main.ts',
      fakeRuntime,
    );
    expect(result.errors).toEqual([]);
    expect(result.bundledPackages).toEqual(['react']);
    expect(result.externals).toEqual([]);
    // Compiled in, not left for an import map.
    expect(result.js).toContain('local-react');
    expect(result.js).not.toContain('from "react"');
  });

  it('shares one instance between packages that import the same chunk', async () => {
    const result = await compile(
      {
        'src/main.ts':
          `import { createElement } from 'react';\n` +
          `import { jsx } from 'react/jsx-runtime';\n` +
          `console.log(createElement, jsx);`,
      },
      'src/main.ts',
      fakeRuntime,
    );
    expect(result.errors).toEqual([]);
    expect(result.bundledPackages.sort()).toEqual(['react', 'react/jsx-runtime']);
    // The shared chunk must appear exactly once, or React would have two
    // copies of its internals and hooks would break.
    expect(result.js.split('single-instance').length - 1).toBe(1);
  });

  it('resolves JSX through the local jsx-runtime', async () => {
    const result = await compile(
      { 'src/App.jsx': `export default function App() { return <div>hi</div>; }` },
      'src/App.jsx',
      fakeRuntime,
    );
    expect(result.errors).toEqual([]);
    expect(result.bundledPackages).toContain('react/jsx-runtime');
    expect(result.externals).toEqual([]);
  });

  it('falls back to external when the runtime lists a package it cannot serve', async () => {
    const broken: PreviewRuntime = { react: '', packages: { react: 'missing.js' }, sources: {} };
    const result = await compile({ 'src/main.ts': `import 'react';` }, 'src/main.ts', broken);
    expect(result.externals).toEqual(['react']);
    expect(result.bundledPackages).toEqual([]);
  });

  it('reports a runtime chunk that is missing rather than failing silently', async () => {
    const truncated: PreviewRuntime = {
      react: '',
      packages: { react: 'react.js' },
      sources: { 'react.js': `export * from "./gone.js";` },
    };
    const result = await compile({ 'src/main.ts': `import 'react';` }, 'src/main.ts', truncated);
    expect(result.errors.join(' ')).toMatch(/missing chunk "gone\.js"/);
  });

  it('leaves absolute URLs alone', async () => {
    const result = await compile(
      { 'src/main.ts': `import 'https://example.com/x.js';` },
      'src/main.ts',
    );
    expect(result.errors).toEqual([]);
    expect(result.externals).toEqual([]);
  });
});

describe('isBareSpecifier', () => {
  it.each(['react', '@scope/pkg', 'lodash/merge'])('treats %s as bare', (spec) => {
    expect(isBareSpecifier(spec)).toBe(true);
  });

  it.each(['./x', '../x', '/x', 'https://x/y.js', 'data:text/javascript,'])(
    'treats %s as not bare',
    (spec) => {
      expect(isBareSpecifier(spec)).toBe(false);
    },
  );
});
