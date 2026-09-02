import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_RUNTIME,
  loadPreviewRuntime,
  resetPreviewRuntime,
  runtimeLoadError,
  runtimeSpecifiers,
} from '@/lib/previewRuntime';

/**
 * The local preview runtime is what lets React previews work with no network.
 * When it fails to load, everything still works via the CDN — so a regression
 * here is silent unless these tests catch it.
 */

const manifest = {
  nodeEnv: 'development',
  react: '18.3.1',
  packages: { react: 'react.js', 'react/jsx-runtime': 'jsx-runtime.js' },
  files: ['react.js', 'jsx-runtime.js', 'chunk-abc.js'],
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = (body: string) => new Response(body, { status: 200 });

beforeEach(() => resetPreviewRuntime());
afterEach(() => {
  vi.unstubAllGlobals();
  resetPreviewRuntime();
});

describe('loadPreviewRuntime', () => {
  it('fetches the manifest and every file it names', async () => {
    const spy = mockFetch((url) => {
      if (url.endsWith('manifest.json')) return ok(JSON.stringify(manifest));
      return ok(`// ${url}`);
    });

    const runtime = await loadPreviewRuntime();
    expect(runtime.react).toBe('18.3.1');
    expect(runtime.packages).toEqual(manifest.packages);
    expect(Object.keys(runtime.sources).sort()).toEqual([
      'chunk-abc.js',
      'jsx-runtime.js',
      'react.js',
    ]);
    expect(runtimeLoadError()).toBeNull();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  /**
   * The manifest keeps one URL across deployments while the chunks it names are
   * content-hashed. Caching the manifest hard would hand back chunk names that
   * no longer exist, every chunk fetch would 404, and the runtime would fall
   * back to the CDN with no visible reason. That happened; this locks it down.
   */
  it('revalidates the manifest but caches the hashed chunks', async () => {
    const seen: Array<{ url: string; cache?: string }> = [];
    mockFetch((url, init) => {
      seen.push({ url, cache: init?.cache });
      if (url.endsWith('manifest.json')) return ok(JSON.stringify(manifest));
      return ok('// chunk');
    });

    await loadPreviewRuntime();
    const manifestCall = seen.find((call) => call.url.endsWith('manifest.json'));
    expect(manifestCall?.cache).toBe('no-cache');
    for (const call of seen.filter((c) => !c.url.endsWith('manifest.json'))) {
      expect(call.cache).toBe('force-cache');
    }
  });

  it('caches the result so a second build does not refetch', async () => {
    const spy = mockFetch((url) =>
      ok(url.endsWith('manifest.json') ? JSON.stringify(manifest) : '// chunk'),
    );
    await loadPreviewRuntime();
    await loadPreviewRuntime();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('falls back to an empty runtime when the assets are absent', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));
    const runtime = await loadPreviewRuntime();
    expect(runtime).toEqual(EMPTY_RUNTIME);
    expect(runtimeLoadError()).toMatch(/HTTP 404/);
  });

  // A dev server that answers with the SPA fallback returns HTML, not JSON.
  it('falls back when the manifest is not JSON', async () => {
    mockFetch(() => ok('<!doctype html><html></html>'));
    const runtime = await loadPreviewRuntime();
    expect(runtime).toEqual(EMPTY_RUNTIME);
    expect(runtimeLoadError()).toBeTruthy();
  });

  it('falls back when the manifest is missing required fields', async () => {
    mockFetch(() => ok(JSON.stringify({ react: '18' })));
    expect(await loadPreviewRuntime()).toEqual(EMPTY_RUNTIME);
    expect(runtimeLoadError()).toMatch(/malformed/);
  });

  it('falls back when a named chunk is missing', async () => {
    mockFetch((url) => {
      if (url.endsWith('manifest.json')) return ok(JSON.stringify(manifest));
      if (url.endsWith('chunk-abc.js')) return new Response('', { status: 404 });
      return ok('// chunk');
    });
    expect(await loadPreviewRuntime()).toEqual(EMPTY_RUNTIME);
    expect(runtimeLoadError()).toMatch(/chunk-abc\.js/);
  });

  it('never rejects, whatever the network does', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(loadPreviewRuntime()).resolves.toEqual(EMPTY_RUNTIME);
    expect(runtimeLoadError()).toMatch(/Failed to fetch/);
  });
});

describe('runtimeSpecifiers', () => {
  it('lists the served specifiers in a stable order', () => {
    expect(
      runtimeSpecifiers({ react: '18', packages: { b: 'b.js', a: 'a.js' }, sources: {} }),
    ).toEqual(['a', 'b']);
    expect(runtimeSpecifiers(EMPTY_RUNTIME)).toEqual([]);
  });
});
