import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDependency,
  assertPackageName,
  listInstalled,
  parseManifest,
  removeDependency,
  resolveVersion,
  RegistryError,
  searchPackages,
} from '@/lib/packages';

afterEach(() => vi.unstubAllGlobals());

const manifest = JSON.stringify(
  { name: 'demo', dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^7.0.0' } },
  null,
  2,
);

describe('manifest handling', () => {
  it('lists dependencies with their bucket', () => {
    expect(listInstalled(manifest)).toEqual([
      { name: 'react', version: '^18.3.1', dev: false },
      { name: 'vite', version: '^7.0.0', dev: true },
    ]);
  });

  it('returns an empty list for a malformed manifest instead of throwing', () => {
    expect(listInstalled('{ not json')).toEqual([]);
  });

  it('raises a readable error when parsing a malformed manifest directly', () => {
    expect(() => parseManifest('{ not json')).toThrow(RegistryError);
  });

  it('rejects a manifest that is not an object', () => {
    expect(() => parseManifest('[1,2]')).toThrow(/JSON object/);
  });
});

describe('package names', () => {
  it.each(['react', '@scope/pkg', 'a-b.c'])('accepts %s', (name) => {
    expect(assertPackageName(name)).toBe(name);
  });

  it.each(['', 'Uppercase', '../evil', 'has space', 'a'.repeat(250)])('rejects %s', (name) => {
    expect(() => assertPackageName(name)).toThrow(RegistryError);
  });
});

describe('addDependency', () => {
  it('resolves latest from the registry and pins a caret range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ 'dist-tags': { latest: '5.0.2' } }), { status: 200 }),
      ),
    );
    const result = await addDependency(manifest, 'zustand', false);
    expect(result.version).toBe('5.0.2');
    expect(JSON.parse(result.manifest).dependencies.zustand).toBe('^5.0.2');
  });

  it('accepts an explicit version without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await addDependency(manifest, 'zustand@4.5.0', false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.version).toBe('4.5.0');
  });

  it('moves a package between dependency buckets rather than duplicating it', async () => {
    const result = await addDependency(manifest, 'react@18.3.1', true);
    const parsed = JSON.parse(result.manifest);
    expect(parsed.devDependencies.react).toBe('^18.3.1');
    expect(parsed.dependencies.react).toBeUndefined();
  });

  it('surfaces a 404 as a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(resolveVersion('definitely-not-a-real-package')).rejects.toThrow(/was not found/);
  });

  it('surfaces other registry failures with the status code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(resolveVersion('react')).rejects.toThrow(/HTTP 503/);
  });
});

describe('removeDependency', () => {
  it('removes from either bucket', () => {
    expect(JSON.parse(removeDependency(manifest, 'react')).dependencies.react).toBeUndefined();
    expect(JSON.parse(removeDependency(manifest, 'vite')).devDependencies.vite).toBeUndefined();
  });

  it('reports a package that is not listed', () => {
    expect(() => removeDependency(manifest, 'missing')).toThrow(/not listed/);
  });
});

describe('searchPackages', () => {
  it('maps registry results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            objects: [
              {
                package: {
                  name: 'zustand',
                  version: '5.0.2',
                  description: 'state',
                  publisher: { username: 'dai' },
                  links: {},
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const results = await searchPackages('zustand');
    expect(results[0]).toMatchObject({ name: 'zustand', version: '5.0.2', publisher: 'dai' });
  });

  it('short-circuits an empty query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchPackages('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
