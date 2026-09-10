/**
 * The extension system: what one is, what it may do, and where they come from.
 *
 * **There is no marketplace, and this does not pretend there is one.** A
 * registry is a server that serves extension manifests, and this deployment has
 * none configured. Rather than shipping a browsable list of things that cannot
 * actually be installed — the exact fake the brief forbids — discovery reports
 * that no registry is configured and says what one would have to provide.
 *
 * What *is* real is the architecture around that hole, and it is the part that
 * matters: a manifest shape, a capability model, an install lifecycle with
 * enable and disable, per-extension settings, and a compatibility check. A real
 * registry can be pointed at this without the IDE changing.
 *
 * **Capabilities are the security model.** An extension declares what it needs
 * and is granted nothing else. The set below is deliberately small and contains
 * no capability that would let an extension reach the container, the gateway,
 * the network, or another project — because an extension host that can do those
 * things is a way around every boundary TA CODE has, and adding one later
 * should require deciding to, not merely forgetting not to.
 */

export type Capability =
  /** Read the open project's files. */
  | 'read-files'
  /** Write to the open project's files. */
  | 'write-files'
  /** Add commands to the command palette. */
  | 'commands'
  /** Contribute a colour theme. */
  | 'theme'
  /** Add a panel to the workspace. */
  | 'panel'
  /** Read editor state: the open file, the selection, diagnostics. */
  | 'editor-state';

export const CAPABILITY_LABEL: Record<Capability, string> = {
  'read-files': 'Read your project’s files',
  'write-files': 'Change your project’s files',
  commands: 'Add commands',
  theme: 'Change the colour theme',
  panel: 'Add a panel',
  'editor-state': 'See the open file and selection',
};

/** Capabilities that let an extension change something. */
export const WRITING_CAPABILITIES: readonly Capability[] = ['write-files'];

export const ALL_CAPABILITIES: readonly Capability[] = [
  'read-files',
  'write-files',
  'commands',
  'theme',
  'panel',
  'editor-state',
];

/**
 * Things an extension can never ask for.
 *
 * Named so the refusal is explicit rather than implied by absence. Each is a
 * boundary elsewhere in TA CODE — the container, the gateway, the network, the
 * secrets model — and an extension that could cross one would make that
 * boundary decorative.
 */
export const FORBIDDEN_CAPABILITIES: readonly string[] = [
  'terminal',
  'container',
  'shell',
  'network',
  'secrets',
  'gateway',
  'other-projects',
  'host-filesystem',
];

export type ExtensionCategory = 'theme' | 'language' | 'tool' | 'integration' | 'formatter';

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: ExtensionCategory;
  capabilities: Capability[];
  /** The TA CODE version range this declares support for. */
  engine: string;
  /** Settings the extension exposes, with their defaults. */
  settings?: Array<{
    key: string;
    label: string;
    type: 'boolean' | 'string' | 'number';
    default: boolean | string | number;
  }>;
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  enabled: boolean;
  installedAt: number;
  /** Values for the manifest's settings, by key. */
  settings: Record<string, boolean | string | number>;
}

export type ManifestProblem =
  | { kind: 'shape'; message: string }
  | { kind: 'forbidden-capability'; message: string; capability: string }
  | { kind: 'unknown-capability'; message: string; capability: string }
  | { kind: 'incompatible'; message: string };

/** This build's version, for the compatibility check below. */
export const ENGINE_VERSION = '1.0.0';

/** A very small subset of semver: `^1.2.3`, `>=1.0.0`, `1.x`, or `*`. */
export function satisfiesEngine(range: string, version = ENGINE_VERSION): boolean {
  const clean = range.trim();
  if (!clean || clean === '*') return true;

  const [major, minor, patch] = version.split('.').map(Number);
  const parse = (text: string) => {
    const parts = text.replace(/[^0-9.x]/g, '').split('.');
    return parts.map((part) => (part === 'x' ? null : Number(part)));
  };

  if (clean.startsWith('^')) {
    const [wantMajor] = parse(clean);
    return wantMajor === null || wantMajor === major;
  }
  if (clean.startsWith('>=')) {
    const [wantMajor = 0, wantMinor = 0, wantPatch = 0] = parse(clean).map((part) => part ?? 0);
    if (major !== wantMajor) return major > wantMajor;
    if (minor !== wantMinor) return minor > wantMinor;
    return patch >= wantPatch;
  }
  const [wantMajor, wantMinor] = parse(clean);
  if (wantMajor !== null && wantMajor !== major) return false;
  if (wantMinor !== null && wantMinor !== undefined && wantMinor !== minor) return false;
  return true;
}

/**
 * Check a manifest before anything is installed.
 *
 * Everything a manifest contains came from outside, so nothing in it is
 * assumed. A manifest that asks for a forbidden capability is refused by name —
 * not silently stripped, because an extension that expected `terminal` and
 * quietly did not get it would fail in ways nobody could explain.
 */
export function validateManifest(raw: unknown): {
  manifest: ExtensionManifest | null;
  problems: ManifestProblem[];
} {
  const problems: ManifestProblem[] = [];
  if (!raw || typeof raw !== 'object') {
    return { manifest: null, problems: [{ kind: 'shape', message: 'That is not a manifest.' }] };
  }

  const value = raw as Record<string, unknown>;
  const text = (key: string, max: number): string =>
    typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : '';

  const id = text('id', 64);
  const name = text('name', 80);
  const version = text('version', 32);

  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    problems.push({
      kind: 'shape',
      message: 'An extension needs an id of letters, digits, dots, dashes or underscores.',
    });
  }
  if (!name) problems.push({ kind: 'shape', message: 'An extension needs a name.' });
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    problems.push({ kind: 'shape', message: 'An extension needs a version like 1.0.0.' });
  }

  const declared = Array.isArray(value.capabilities) ? value.capabilities : [];
  const capabilities: Capability[] = [];
  for (const entry of declared) {
    const capability = String(entry);
    if (FORBIDDEN_CAPABILITIES.includes(capability)) {
      problems.push({
        kind: 'forbidden-capability',
        capability,
        message: `"${capability}" is not a capability an extension can be granted. Terminals, containers, the network and secrets are outside the extension boundary.`,
      });
      continue;
    }
    if (!ALL_CAPABILITIES.includes(capability as Capability)) {
      problems.push({
        kind: 'unknown-capability',
        capability,
        message: `"${capability}" is not a capability this version understands.`,
      });
      continue;
    }
    capabilities.push(capability as Capability);
  }

  const engine = text('engine', 32) || '*';
  if (!satisfiesEngine(engine)) {
    problems.push({
      kind: 'incompatible',
      message: `This extension declares support for TA CODE ${engine}; this is ${ENGINE_VERSION}.`,
    });
  }

  const category = ['theme', 'language', 'tool', 'integration', 'formatter'].includes(
    String(value.category),
  )
    ? (value.category as ExtensionCategory)
    : 'tool';

  if (problems.some((problem) => problem.kind === 'shape')) {
    return { manifest: null, problems };
  }

  const settings = Array.isArray(value.settings)
    ? (value.settings as Array<Record<string, unknown>>)
        .filter(
          (setting) =>
            typeof setting.key === 'string' &&
            ['boolean', 'string', 'number'].includes(String(setting.type)),
        )
        .slice(0, 30)
        .map((setting) => ({
          key: String(setting.key).slice(0, 64),
          label: typeof setting.label === 'string' ? setting.label.slice(0, 120) : String(setting.key),
          type: setting.type as 'boolean' | 'string' | 'number',
          default: (setting.default ?? '') as boolean | string | number,
        }))
    : undefined;

  return {
    manifest: {
      id,
      name,
      version,
      description: text('description', 400),
      author: text('author', 80) || 'Unknown',
      category,
      capabilities,
      engine,
      settings,
    },
    problems,
  };
}

/** Whether the problems found are bad enough to refuse the install. */
export function blocksInstall(problems: ManifestProblem[]): boolean {
  return problems.some(
    (problem) =>
      problem.kind === 'shape' ||
      problem.kind === 'forbidden-capability' ||
      problem.kind === 'incompatible',
  );
}

export interface RegistryStatus {
  configured: boolean;
  /** Where extensions would come from, when one is configured. */
  url: string | null;
  reason: string;
}

/**
 * Where extensions come from.
 *
 * Read from the environment, and honest when there is nothing there. A
 * browsable list of extensions that cannot be installed is worse than an empty
 * panel: it promises a feature that does not exist and wastes the attention of
 * somebody looking for one that does.
 */
export function registryStatus(url: string | undefined = import.meta.env.VITE_EXTENSION_REGISTRY_URL): RegistryStatus {
  const clean = typeof url === 'string' ? url.trim() : '';
  if (!clean) {
    return {
      configured: false,
      url: null,
      reason:
        'No extension registry is configured, so there is nothing to browse. Set VITE_EXTENSION_REGISTRY_URL to a service that serves extension manifests, and discovery will read from it.',
    };
  }
  if (!/^https:\/\//.test(clean)) {
    return {
      configured: false,
      url: null,
      reason: 'The configured extension registry is not an https URL, so it will not be used.',
    };
  }
  return { configured: true, url: clean, reason: '' };
}
