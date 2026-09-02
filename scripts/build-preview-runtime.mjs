/**
 * Pre-bundles the packages the built-in templates need into standalone ES
 * modules served from the app's own origin.
 *
 * Why this exists
 * ---------------
 * The in-browser bundler leaves bare imports (`react`, `react-dom/client`, …)
 * external, and the preview resolves them at runtime from a package CDN. That
 * makes the React and Vite templates fail on any network that blocks the CDN,
 * and makes the product's flagship templates untestable offline.
 *
 * These bundles let the browser bundler resolve those specifiers locally, so a
 * React preview needs no network at all. The CDN path stays for every package
 * we do not ship.
 *
 * How it works
 * ------------
 * Each specifier gets a wrapper module that re-exports the package's real
 * export names one by one (see {@link wrapperSource} for why `export *` does
 * not work over CommonJS). Code splitting then hoists React's internals into a
 * shared chunk, which is what keeps a single React instance across `react`,
 * `react-dom` and the JSX runtimes — two instances would break hooks the moment
 * a component rendered.
 *
 * The output is generated, not committed: `predev` and `prebuild` run it, and
 * the manifest tells the runtime exactly what is available.
 *
 * Run manually with:  node scripts/build-preview-runtime.mjs
 */
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'preview-runtime');

const SPECIFIERS = [
  { specifier: 'react', name: 'react' },
  { specifier: 'react/jsx-runtime', name: 'jsx-runtime' },
  { specifier: 'react/jsx-dev-runtime', name: 'jsx-dev-runtime' },
  { specifier: 'react-dom', name: 'react-dom' },
  { specifier: 'react-dom/client', name: 'react-dom-client' },
];

/**
 * Development builds are deliberate: React's dev bundles carry the invalid-hook,
 * missing-key and hydration warnings that make a preview worth debugging in.
 * They are fetched once and cached by the browser.
 */
const NODE_ENV = 'development';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Build the wrapper source for one specifier.
 *
 * `export * from 'react'` is not enough: React is CommonJS, so esbuild emits a
 * *runtime* re-export and a consumer's `import { useState } from 'react'` then
 * fails to bundle with "No matching export". Enumerating the real export names
 * here — we can require the package, we are in Node — produces static named
 * exports that esbuild can bind.
 */
function wrapperSource(specifier, require) {
  const namespace = require(specifier);
  const names = Object.keys(namespace)
    .filter((key) => key !== 'default' && IDENTIFIER.test(key))
    .sort();
  const lines = [
    `import __mod from ${JSON.stringify(specifier)};`,
    'export default __mod;',
  ];
  if (!names.length) {
    // Every package we ship has named exports; none means the interop broke.
    throw new Error(`${specifier} exposed no named exports — the wrapper would be useless`);
  }
  lines.push(`export const { ${names.join(', ')} } = __mod;`);
  return { source: `${lines.join('\n')}\n`, names };
}

async function main() {
  process.env.NODE_ENV = NODE_ENV;
  const require = createRequire(import.meta.url);
  const stage = await mkdtemp(join(tmpdir(), 'forge-preview-runtime-'));
  try {
    const entryPoints = {};
    const exportNames = {};
    for (const { specifier, name } of SPECIFIERS) {
      const { source, names } = wrapperSource(specifier, require);
      const file = join(stage, `${name}.mjs`);
      await writeFile(file, source, 'utf8');
      entryPoints[name] = file;
      exportNames[specifier] = names;
    }

    // Clean the contents rather than the directory itself: a running dev
    // server holds the public directory open, and removing it makes Vite stop
    // serving these files until it is restarted.
    await mkdir(outDir, { recursive: true });
    for (const stale of await readdir(outDir).catch(() => [])) {
      await rm(join(outDir, stale), { force: true });
    }

    await build({
      entryPoints,
      absWorkingDir: root,
      // The wrapper modules live in a temp directory, so point Node resolution
      // back at this project's node_modules.
      nodePaths: [join(root, 'node_modules')],
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      outdir: outDir,
      chunkNames: 'chunk-[hash]',
      define: { 'process.env.NODE_ENV': JSON.stringify(NODE_ENV) },
      logLevel: 'silent',
    });

    const emitted = (await readdir(outDir)).filter((file) => file.endsWith('.js'));
    const files = {};
    for (const file of emitted) {
      files[file] = (await readFile(join(outDir, file), 'utf8')).length;
    }

    const packages = {};
    for (const { specifier, name } of SPECIFIERS) {
      const file = `${name}.js`;
      if (!emitted.includes(file)) throw new Error(`esbuild did not emit ${file}`);
      packages[specifier] = file;
    }

    const reactVersion = JSON.parse(
      await readFile(join(root, 'node_modules', 'react', 'package.json'), 'utf8'),
    ).version;

    await writeFile(
      join(outDir, 'manifest.json'),
      `${JSON.stringify(
        { nodeEnv: NODE_ENV, react: reactVersion, packages, files: emitted.sort(), exports: exportNames },
        null,
        2,
      )}\n`,
      'utf8',
    );

    for (const file of emitted.sort()) {
      console.log(`[preview-runtime] ${basename(file).padEnd(24)} ${(files[file] / 1024).toFixed(0)} KB`);
    }
    console.log(
      `[preview-runtime] ${SPECIFIERS.length} specifiers, react@${reactVersion} (${NODE_ENV})`,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

await main();
