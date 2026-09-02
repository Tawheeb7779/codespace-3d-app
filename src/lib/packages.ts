import type { PackageEntry, RegistryPackage } from '@/types';

/**
 * Package management against the public npm registry.
 *
 * There is no node_modules directory in the browser. "Install" means: resolve
 * the real version from registry.npmjs.org and record it in package.json. The
 * preview then loads that exact version from esm.sh through an import map, so
 * the manifest and what runs stay in sync. The UI states this explicitly.
 */

const REGISTRY = 'https://registry.npmjs.org';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface SearchResponse {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      date?: string;
      publisher?: { username?: string };
      links?: { npm?: string; homepage?: string; repository?: string };
    };
  }>;
}

/**
 * Turn a transport failure into something a developer can act on.
 *
 * `fetch` rejects with a bare "Failed to fetch" for a blocked host, an offline
 * machine, a proxy without a trusted certificate and a CORS rejection alike,
 * which tells the reader nothing about what to try next.
 */
async function registryFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RegistryError(
      `Could not reach ${REGISTRY}. Check your network, proxy or extensions — ` +
        'Forge talks to the npm registry directly from this tab.',
    );
  }
}

export async function searchPackages(
  query: string,
  signal?: AbortSignal,
): Promise<RegistryPackage[]> {
  const term = query.trim();
  if (!term) return [];
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(term)}&size=20`;
  const response = await registryFetch(url, { signal });
  if (!response.ok) {
    throw new RegistryError(`npm search failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as SearchResponse;
  return data.objects.map((entry) => ({
    name: entry.package.name,
    version: entry.package.version,
    description: entry.package.description ?? '',
    publisher: entry.package.publisher?.username ?? 'unknown',
    date: entry.package.date ?? '',
    links: entry.package.links ?? {},
  }));
}

/** Resolve a dist-tag (default `latest`) to a concrete version. */
export async function resolveVersion(name: string, tag = 'latest'): Promise<string> {
  const response = await registryFetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  if (response.status === 404) throw new RegistryError(`Package "${name}" was not found on npm`);
  if (!response.ok) throw new RegistryError(`npm registry returned HTTP ${response.status}`);
  const data = (await response.json()) as { 'dist-tags'?: Record<string, string> };
  const version = data['dist-tags']?.[tag];
  if (!version) throw new RegistryError(`Package "${name}" has no "${tag}" tag`);
  return version;
}

const DEFAULT_MANIFEST = {
  name: 'forge-project',
  private: true,
  version: '0.1.0',
  type: 'module',
  dependencies: {} as Record<string, string>,
};

export interface Manifest {
  [key: string]: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function parseManifest(raw: string | undefined): Manifest {
  if (!raw) return { ...DEFAULT_MANIFEST };
  try {
    const parsed = JSON.parse(raw) as Manifest;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('package.json must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new RegistryError(
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function listInstalled(raw: string | undefined): PackageEntry[] {
  let manifest: Manifest;
  try {
    manifest = parseManifest(raw);
  } catch {
    return [];
  }
  const entries: PackageEntry[] = [];
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    entries.push({ name, version: String(version), dev: false });
  }
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    entries.push({ name, version: String(version), dev: true });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** npm's own name rules, so bogus input never reaches the registry. */
const NAME_PATTERN = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export function assertPackageName(name: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 214 || !NAME_PATTERN.test(clean)) {
    throw new RegistryError(`"${name}" is not a valid npm package name`);
  }
  return clean;
}

export interface InstallResult {
  manifest: string;
  name: string;
  version: string;
}

export async function addDependency(
  rawManifest: string | undefined,
  spec: string,
  dev: boolean,
): Promise<InstallResult> {
  const at = spec.lastIndexOf('@');
  const hasVersion = at > 0;
  const name = assertPackageName(hasVersion ? spec.slice(0, at) : spec);
  const requested = hasVersion ? spec.slice(at + 1) : 'latest';
  const version = /^\d/.test(requested) ? requested : await resolveVersion(name, requested);

  const manifest = parseManifest(rawManifest);
  const key = dev ? 'devDependencies' : 'dependencies';
  manifest[key] = { ...(manifest[key] ?? {}), [name]: `^${version}` };
  // A package must not appear in both buckets.
  const other = dev ? 'dependencies' : 'devDependencies';
  if (manifest[other]?.[name]) {
    const copy = { ...manifest[other] };
    delete copy[name];
    manifest[other] = copy;
  }
  return { manifest: serializeManifest(manifest), name, version };
}

export function removeDependency(rawManifest: string | undefined, name: string): string {
  const manifest = parseManifest(rawManifest);
  let found = false;
  for (const key of ['dependencies', 'devDependencies'] as const) {
    if (manifest[key]?.[name]) {
      const copy = { ...manifest[key] };
      delete copy[name];
      manifest[key] = copy;
      found = true;
    }
  }
  if (!found) throw new RegistryError(`"${name}" is not listed in package.json`);
  return serializeManifest(manifest);
}
