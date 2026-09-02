// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { createVfsPlugin } from '@/lib/bundler';
import type { PreviewRuntime } from '@/lib/previewRuntime';

/**
 * Checks the artifacts `scripts/build-preview-runtime.mjs` produces.
 *
 * These caught two real regressions: wrappers built with `export *` over
 * CommonJS emitted no static named exports (every React import failed to
 * bundle), and a build without code splitting duplicated React's internals
 * (two instances, broken hooks).
 *
 * The suite skips itself when the artifacts are absent, so `npm test` still
 * works on a checkout where the prebuild step has not run.
 */

const DIR = join(process.cwd(), 'public', 'preview-runtime');
const MANIFEST = join(DIR, 'manifest.json');
const present = existsSync(MANIFEST);

interface Manifest {
  nodeEnv: string;
  react: string;
  packages: Record<string, string>;
  files: string[];
  exports: Record<string, string[]>;
}

const describeIfBuilt = present ? describe : describe.skip;

describeIfBuilt('generated preview runtime', () => {
  const manifest = present ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest) : null;
  const runtime: PreviewRuntime = present
    ? {
        react: manifest!.react,
        packages: manifest!.packages,
        sources: Object.fromEntries(
          manifest!.files.map((file) => [file, readFileSync(join(DIR, file), 'utf8')]),
        ),
      }
    : { react: '', packages: {}, sources: {} };

  it('ships the specifiers the templates import', () => {
    expect(Object.keys(manifest!.packages).sort()).toEqual([
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-dev-runtime',
      'react/jsx-runtime',
    ]);
  });

  it('names a file for every specifier, and ships every file it names', () => {
    for (const [specifier, file] of Object.entries(manifest!.packages)) {
      expect(manifest!.files, specifier).toContain(file);
      expect(existsSync(join(DIR, file)), file).toBe(true);
    }
  });

  it('exposes the named exports the templates use', () => {
    expect(manifest!.exports.react).toEqual(
      expect.arrayContaining(['useState', 'useEffect', 'createElement', 'Fragment']),
    );
    expect(manifest!.exports['react-dom/client']).toEqual(
      expect.arrayContaining(['createRoot', 'hydrateRoot']),
    );
    expect(manifest!.exports['react/jsx-runtime']).toEqual(
      expect.arrayContaining(['jsx', 'jsxs', 'Fragment']),
    );
  });

  it('links its own modules with real ESM imports, never a dynamic require', () => {
    for (const [file, source] of Object.entries(runtime.sources)) {
      // esbuild turns an externalised CommonJS dependency into __require("./x"),
      // which throws at runtime. Every cross-module link must be a real import.
      expect(/__require\(["'`]\.\//.test(source), `${file} dynamically requires a sibling`).toBe(
        false,
      );

      // Relative targets must all resolve inside the runtime directory. (A
      // plain "from" scan would also hit React's own prose, so match the
      // relative form only.)
      for (const match of source.matchAll(/from\s*"(\.\/[^"]+)"/g)) {
        expect(runtime.sources, `${file} imports missing ${match[1]}`).toHaveProperty(
          match[1].slice(2),
        );
      }
    }
  });

  it('defines React exactly once across all chunks', () => {
    const definitions = Object.values(runtime.sources).reduce(
      (total, source) => total + (source.match(/var require_react = __commonJS/g) ?? []).length,
      0,
    );
    // Two definitions would mean two React instances, and hooks would throw
    // "invalid hook call" the moment a component rendered.
    expect(definitions).toBe(1);
  });

  it('is a development build, so React keeps its warnings', () => {
    expect(manifest!.nodeEnv).toBe('development');
  });

  // The end-to-end proof: a React entry point compiles with no externals left.
  it('lets a React component bundle with nothing left for a CDN', async () => {
    const files = {
      'src/main.jsx':
        `import { useState } from 'react';\n` +
        `import { createRoot } from 'react-dom/client';\n` +
        `function App() { const [n] = useState(1); return <p>{n}</p>; }\n` +
        `createRoot(document.body).render(<App />);\n`,
    };
    const record = { externals: new Set<string>(), bundledPackages: new Set<string>() };
    const plugin = createVfsPlugin(files, 'src/main.jsx', runtime, record) as unknown as Plugin;

    const result = await build({
      entryPoints: ['src/main.jsx'],
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

    expect(result.errors).toEqual([]);
    expect([...record.externals]).toEqual([]);
    expect([...record.bundledPackages].sort()).toEqual([
      'react',
      'react-dom/client',
      'react/jsx-runtime',
    ]);

    // One React instance in the compiled output too.
    const js = (result.outputFiles ?? []).map((f) => f.text).join('\n');
    expect((js.match(/var require_react = __commonJS/g) ?? []).length).toBe(1);
  }, 30_000);
});
