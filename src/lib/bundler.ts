import type * as ESBuild from 'esbuild-wasm';
import { dirname, extname, resolveRelative } from '@/lib/vfs';
import { EMPTY_RUNTIME, type PreviewRuntime } from '@/lib/previewRuntime';

/**
 * In-browser bundler.
 *
 * esbuild-wasm compiles the project's real source files. Bare imports resolve
 * in two steps:
 *
 *  1. Against the locally hosted preview runtime (React and its JSX runtimes),
 *     which is compiled straight into the bundle. No network, works offline.
 *  2. Otherwise left external, for the preview's import map to resolve from a
 *     package CDN. That is what lets the package manager add an arbitrary
 *     dependency without a node_modules directory.
 */

export interface BuildDiagnostic {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface BuildResult {
  js: string;
  css: string;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  /** Bare module specifiers that must be supplied by the import map (CDN). */
  externals: string[];
  /** Bare specifiers satisfied from the locally hosted runtime. */
  bundledPackages: string[];
  durationMs: number;
}

let esbuild: typeof ESBuild | null = null;
let initPromise: Promise<typeof ESBuild> | null = null;

const RESOLVE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css'];
const LOADERS: Record<string, ESBuild.Loader> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'jsx',
  jsx: 'jsx',
  mjs: 'jsx',
  cjs: 'jsx',
  json: 'json',
  css: 'css',
  txt: 'text',
  svg: 'text',
};

/** Lazily load and initialise the wasm binary (~9 MB, fetched once). */
export async function initBundler(): Promise<typeof ESBuild> {
  if (esbuild) return esbuild;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const [mod, wasmUrl] = await Promise.all([
      import('esbuild-wasm'),
      import('esbuild-wasm/esbuild.wasm?url').then((m) => m.default as string),
    ]);
    await mod.initialize({ wasmURL: wasmUrl, worker: true });
    esbuild = mod;
    return mod;
  })().catch((error) => {
    initPromise = null;
    throw new Error(
      `Bundler failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return initPromise;
}

export function isBundlerReady(): boolean {
  return esbuild !== null;
}

function resolveInVfs(files: Record<string, string>, spec: string, importer: string): string | null {
  let candidate: string;
  try {
    // A parent-relative import is ordinary; resolveRelative collapses the `..`
    // segments and still refuses to climb out of the project.
    candidate = resolveRelative(dirname(importer), spec);
  } catch {
    return null;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const path = `${candidate}${ext}`;
    if (path in files) return path;
  }
  for (const ext of RESOLVE_EXTENSIONS.slice(1)) {
    const path = `${candidate}/index${ext}`;
    if (path in files) return path;
  }
  return null;
}

function toDiagnostic(
  message: ESBuild.Message,
  severity: 'error' | 'warning',
): BuildDiagnostic {
  return {
    path: message.location?.file?.replace(/^vfs:/, '') ?? '',
    line: message.location?.line ?? 1,
    column: (message.location?.column ?? 0) + 1,
    message: message.text,
    severity,
  };
}

/** True for a bare specifier such as `react` or `@scope/pkg`. */
export function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z]+:/i.test(spec);
}

/** Namespace holding the locally bundled runtime modules. */
export const PKG_NAMESPACE = 'forge-pkg';

/**
 * The module resolver, split out from {@link bundle} so it can be exercised
 * against a real esbuild in tests without loading the wasm build. The two
 * esbuild APIs are identical in the surface this uses.
 */
export function createVfsPlugin(
  files: Record<string, string>,
  entry: string,
  runtime: PreviewRuntime,
  record: { externals: Set<string>; bundledPackages: Set<string> },
): ESBuild.Plugin {
  const { externals, bundledPackages } = record;
  return {
    name: 'forge-vfs',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: entry, namespace: 'vfs' };
        if (/^https?:/.test(args.path)) return { path: args.path, external: true };

        // Relative imports between the runtime's own chunks.
        if (args.namespace === PKG_NAMESPACE && args.path.startsWith('.')) {
          const file = args.path.replace(/^\.\//, '');
          if (file in runtime.sources) return { path: file, namespace: PKG_NAMESPACE };
          return {
            errors: [{ text: `Preview runtime is missing chunk "${file}". Rebuild it.` }],
          };
        }

        if (isBareSpecifier(args.path)) {
          const local = runtime.packages[args.path];
          if (local && local in runtime.sources) {
            bundledPackages.add(args.path);
            return { path: local, namespace: PKG_NAMESPACE };
          }
          externals.add(args.path);
          return { path: args.path, external: true };
        }

        const resolved = resolveInVfs(files, args.path, args.importer);
        if (!resolved) {
          return {
            errors: [
              {
                text: `Cannot resolve "${args.path}" from "${args.importer}". No such file in this project.`,
              },
            ],
          };
        }
        return { path: resolved, namespace: 'vfs' };
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => ({
        contents: files[args.path] ?? '',
        loader: LOADERS[extname(args.path)] ?? 'text',
        resolveDir: dirname(args.path),
      }));

      pluginBuild.onLoad({ filter: /.*/, namespace: PKG_NAMESPACE }, (args) => ({
        contents: runtime.sources[args.path] ?? '',
        loader: 'js',
      }));
    },
  };
}

export async function bundle(
  files: Record<string, string>,
  entry: string,
  runtime: PreviewRuntime = EMPTY_RUNTIME,
): Promise<BuildResult> {
  const started = performance.now();
  const build = await initBundler();
  const externals = new Set<string>();
  const bundledPackages = new Set<string>();
  const vfsPlugin = createVfsPlugin(files, entry, runtime, { externals, bundledPackages });

  try {
    const result = await build.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2020',
      platform: 'browser',
      sourcemap: 'inline',
      jsx: 'automatic',
      jsxImportSource: 'react',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [vfsPlugin],
      outdir: 'out',
    });

    let js = '';
    let css = '';
    for (const file of result.outputFiles ?? []) {
      if (file.path.endsWith('.css')) css += file.text;
      else js += file.text;
    }

    return {
      js,
      css,
      errors: result.errors.map((m) => toDiagnostic(m, 'error')),
      warnings: result.warnings.map((m) => toDiagnostic(m, 'warning')),
      externals: [...externals],
      bundledPackages: [...bundledPackages],
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const buildError = error as ESBuild.BuildFailure;
    const errors = Array.isArray(buildError.errors) && buildError.errors.length
      ? buildError.errors.map((m) => toDiagnostic(m, 'error'))
      : [
          {
            path: entry,
            line: 1,
            column: 1,
            message: error instanceof Error ? error.message : String(error),
            severity: 'error' as const,
          },
        ];
    return {
      js: '',
      css: '',
      errors,
      warnings: (buildError.warnings ?? []).map((m) => toDiagnostic(m, 'warning')),
      externals: [...externals],
      bundledPackages: [...bundledPackages],
      durationMs: Math.round(performance.now() - started),
    };
  }
}
