import type * as ESBuild from 'esbuild-wasm';
import { dirname, extname, normalizePath } from '@/lib/vfs';

/**
 * In-browser bundler.
 *
 * esbuild-wasm compiles the project's real source files. Bare imports are left
 * external and resolved at runtime through an import map pointing at esm.sh —
 * that is why the package manager can add a dependency and the preview picks it
 * up without a node_modules directory.
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
  /** Bare module specifiers that must be supplied by the import map. */
  externals: string[];
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
  const base = spec.startsWith('/') ? spec.slice(1) : `${dirname(importer)}/${spec}`;
  let candidate: string;
  try {
    candidate = normalizePath(base);
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

export async function bundle(
  files: Record<string, string>,
  entry: string,
): Promise<BuildResult> {
  const started = performance.now();
  const build = await initBundler();
  const externals = new Set<string>();

  const vfsPlugin: ESBuild.Plugin = {
    name: 'forge-vfs',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: entry, namespace: 'vfs' };
        if (/^https?:/.test(args.path)) return { path: args.path, external: true };
        if (isBareSpecifier(args.path)) {
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
    },
  };

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
      durationMs: Math.round(performance.now() - started),
    };
  }
}
