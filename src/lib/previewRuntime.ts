/**
 * Locally hosted packages for the preview bundler.
 *
 * `scripts/build-preview-runtime.mjs` pre-bundles React and its JSX runtimes
 * into ES modules under `public/preview-runtime/`. This module fetches them
 * from the app's own origin and hands them to the bundler, which resolves the
 * matching bare specifiers against them instead of leaving them external.
 *
 * The fetch happens in the IDE window — same origin, no CORS — and the sources
 * are compiled straight into the preview bundle. The sandboxed iframe therefore
 * makes no network request of its own for these packages, so a React preview
 * works offline and behind a CDN block.
 *
 * Anything not listed in the manifest still falls through to the configured
 * package CDN, which is what keeps arbitrary npm installs working.
 */

export interface PreviewRuntime {
  /** Bare specifier -> file name inside the runtime directory. */
  packages: Record<string, string>;
  /** File name -> module source, including shared chunks. */
  sources: Record<string, string>;
  /** React version these bundles were produced from. */
  react: string;
}

interface Manifest {
  nodeEnv: string;
  react: string;
  packages: Record<string, string>;
  files: string[];
}

export const RUNTIME_BASE = '/preview-runtime';

/** An empty runtime: every bare import falls through to the CDN. */
export const EMPTY_RUNTIME: PreviewRuntime = { packages: {}, sources: {}, react: '' };

let cached: Promise<PreviewRuntime> | null = null;
let lastError: string | null = null;

/**
 * `revalidate` for the manifest, `immutable` for the chunks it names.
 *
 * The chunk file names carry a content hash, so caching them hard is free. The
 * manifest keeps one URL across deployments, so caching it hard would hand us a
 * list of chunk names that no longer exist — every fetch would 404 and the
 * whole runtime would silently fall back to the CDN.
 */
async function fetchText(url: string, mode: 'revalidate' | 'immutable'): Promise<string> {
  const response = await fetch(url, { cache: mode === 'immutable' ? 'force-cache' : 'no-cache' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

/**
 * Load the bundled runtime. Resolves to {@link EMPTY_RUNTIME} when the assets
 * are absent — a deployment that skipped the prebuild step still works, it just
 * falls back to the CDN — so callers never have to handle a rejection.
 */
export function loadPreviewRuntime(): Promise<PreviewRuntime> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const manifest = JSON.parse(
        await fetchText(`${RUNTIME_BASE}/manifest.json`, 'revalidate'),
      ) as Manifest;
      if (!manifest?.packages || !Array.isArray(manifest.files)) {
        throw new Error('manifest.json is malformed');
      }
      const entries = await Promise.all(
        manifest.files.map(
          async (file) =>
            [file, await fetchText(`${RUNTIME_BASE}/${file}`, 'immutable')] as const,
        ),
      );
      lastError = null;
      return {
        packages: manifest.packages,
        sources: Object.fromEntries(entries),
        react: manifest.react,
      };
    } catch (error) {
      // Not fatal: record why, and let the CDN fallback take over.
      lastError = error instanceof Error ? error.message : String(error);
      return EMPTY_RUNTIME;
    }
  })();
  return cached;
}

/** Why the local runtime is unavailable, or null when it loaded. */
export function runtimeLoadError(): string | null {
  return lastError;
}

/** Test seam: drop the cached runtime so the next load refetches. */
export function resetPreviewRuntime(): void {
  cached = null;
  lastError = null;
}

/** Packages the local runtime can serve, for display in the UI. */
export function runtimeSpecifiers(runtime: PreviewRuntime): string[] {
  return Object.keys(runtime.packages).sort();
}
