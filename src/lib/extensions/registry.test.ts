import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  FORBIDDEN_CAPABILITIES,
  blocksInstall,
  registryStatus,
  satisfiesEngine,
  validateManifest,
} from '@/lib/extensions/registry';
import { useExtensionStore } from '@/stores/extensionStore';

/**
 * An extension system, and the two things it must not do.
 *
 * It must not present a marketplace that is not there. No registry is
 * configured in this deployment, and a browsable catalogue of extensions that
 * cannot be installed is worse than an empty panel — it promises a feature that
 * does not exist and spends the attention meant for one that does.
 *
 * And it must not let an extension across a boundary. The capability set is the
 * security model: a manifest asking for a terminal, the container, the network
 * or secrets is refused *by name*, never installed with that capability quietly
 * dropped. An extension that expected it and silently did not get it fails in
 * ways nobody can explain — and an extension host that could reach those things
 * would make every other boundary in TA CODE decorative.
 */

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'test-ext',
  name: 'Test',
  version: '1.0.0',
  description: 'A test extension',
  author: 'Someone',
  category: 'tool',
  capabilities: ['read-files'],
  engine: '*',
  ...over,
});

describe('the registry', () => {
  /** Said plainly, rather than shown as an empty catalogue. */
  it('reports that none is configured, and what one would need to be', () => {
    const status = registryStatus(undefined);

    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/no extension registry is configured/i);
    expect(status.reason).toMatch(/VITE_EXTENSION_REGISTRY_URL/);
  });

  it('refuses a registry that is not https', () => {
    expect(registryStatus('http://registry.test').configured).toBe(false);
  });

  it('accepts a configured https registry', () => {
    const status = registryStatus('https://registry.test');

    expect(status.configured).toBe(true);
    expect(status.url).toBe('https://registry.test');
  });
});

describe('validating a manifest', () => {
  it('accepts a well-formed one', () => {
    const { manifest: parsed, problems } = validateManifest(manifest());

    expect(parsed?.id).toBe('test-ext');
    expect(blocksInstall(problems)).toBe(false);
  });

  it.each([null, 'a string', 42, []])('refuses %j as a manifest', (raw) => {
    expect(validateManifest(raw).manifest).toBeNull();
  });

  it.each([
    ['no id', { id: '' }],
    ['no name', { name: '' }],
    ['no version', { version: 'one' }],
  ])('refuses a manifest with %s', (_label, over) => {
    const { manifest: parsed } = validateManifest(manifest(over));

    expect(parsed).toBeNull();
  });

  /**
   * The refusal that matters. Dropping it silently would leave an extension
   * expecting a capability it does not have.
   */
  it.each(FORBIDDEN_CAPABILITIES)('refuses a manifest asking for %s, by name', (capability) => {
    const { problems } = validateManifest(manifest({ capabilities: [capability] }));

    const refusal = problems.find((problem) => problem.kind === 'forbidden-capability');
    expect(refusal).toBeTruthy();
    expect(refusal?.message).toContain(capability);
    expect(blocksInstall(problems)).toBe(true);
  });

  it('reports an unknown capability without blocking the install', () => {
    const { problems, manifest: parsed } = validateManifest(
      manifest({ capabilities: ['read-files', 'telepathy'] }),
    );

    expect(problems.some((problem) => problem.kind === 'unknown-capability')).toBe(true);
    expect(blocksInstall(problems)).toBe(false);
    // The one it did not understand is not granted.
    expect(parsed?.capabilities).toEqual(['read-files']);
  });

  it('bounds the strings it takes from a manifest', () => {
    const { manifest: parsed } = validateManifest(
      manifest({ name: 'x'.repeat(500), description: 'y'.repeat(5000) }),
    );

    expect(parsed!.name.length).toBeLessThanOrEqual(80);
    expect(parsed!.description.length).toBeLessThanOrEqual(400);
  });

  it('bounds how many settings a manifest may declare', () => {
    const settings = Array.from({ length: 100 }, (_, index) => ({
      key: `k${index}`,
      label: `Setting ${index}`,
      type: 'boolean',
      default: false,
    }));

    const { manifest: parsed } = validateManifest(manifest({ settings }));

    expect(parsed!.settings!.length).toBeLessThanOrEqual(30);
  });

  it('falls back to a known category rather than trusting the manifest', () => {
    const { manifest: parsed } = validateManifest(manifest({ category: 'malware' }));

    expect(parsed?.category).toBe('tool');
  });
});

describe('compatibility', () => {
  it.each(['*', '^1.0.0', '1.x', '>=1.0.0', ''])('accepts the range %j', (range) => {
    expect(satisfiesEngine(range, '1.0.0')).toBe(true);
  });

  it.each(['^2.0.0', '2.x', '>=2.0.0'])('refuses the range %j against 1.0.0', (range) => {
    expect(satisfiesEngine(range, '1.0.0')).toBe(false);
  });

  it('blocks an install that declares an incompatible engine', () => {
    const { problems } = validateManifest(manifest({ engine: '^9.0.0' }));

    expect(problems.some((problem) => problem.kind === 'incompatible')).toBe(true);
    expect(blocksInstall(problems)).toBe(true);
  });

  it('names both versions in the message', () => {
    const { problems } = validateManifest(manifest({ engine: '^9.0.0' }));
    const problem = problems.find((entry) => entry.kind === 'incompatible');

    expect(problem?.message).toContain('^9.0.0');
    expect(problem?.message).toContain(ENGINE_VERSION);
  });
});

describe('the install lifecycle', () => {
  beforeEach(() => {
    useExtensionStore.setState({ installed: [], lastProblems: [] });
  });

  /** Granting capabilities the instant it arrives is a decision nobody made. */
  it('installs disabled', () => {
    useExtensionStore.getState().install(manifest());

    expect(useExtensionStore.getState().installed[0].enabled).toBe(false);
  });

  it('refuses to install a manifest that asks for a terminal', () => {
    const result = useExtensionStore.getState().install(manifest({ capabilities: ['terminal'] }));

    expect(result.ok).toBe(false);
    expect(useExtensionStore.getState().installed).toHaveLength(0);
  });

  it('does not install the same extension twice', () => {
    useExtensionStore.getState().install(manifest());

    const second = useExtensionStore.getState().install(manifest());

    expect(second.ok).toBe(false);
    expect(useExtensionStore.getState().installed).toHaveLength(1);
  });

  /**
   * Decided in one place rather than left to every caller to remember the
   * `enabled` check.
   */
  it('grants nothing at all while disabled', () => {
    useExtensionStore.getState().install(manifest({ capabilities: ['read-files', 'commands'] }));

    expect(useExtensionStore.getState().grantedTo('test-ext')).toEqual([]);
  });

  it('grants exactly what the manifest declared once enabled', () => {
    useExtensionStore.getState().install(manifest({ capabilities: ['read-files', 'commands'] }));
    useExtensionStore.getState().setEnabled('test-ext', true);

    expect(useExtensionStore.getState().grantedTo('test-ext')).toEqual(['read-files', 'commands']);
  });

  it('grants nothing for an extension that is not installed', () => {
    expect(useExtensionStore.getState().grantedTo('never-installed')).toEqual([]);
  });

  it('takes the capabilities away again on disable', () => {
    useExtensionStore.getState().install(manifest());
    useExtensionStore.getState().setEnabled('test-ext', true);

    useExtensionStore.getState().setEnabled('test-ext', false);

    expect(useExtensionStore.getState().grantedTo('test-ext')).toEqual([]);
  });

  it('starts settings at the manifest’s defaults', () => {
    useExtensionStore.getState().install(
      manifest({ settings: [{ key: 'loud', label: 'Loud', type: 'boolean', default: true }] }),
    );

    expect(useExtensionStore.getState().installed[0].settings.loud).toBe(true);
  });

  it('keeps a changed setting', () => {
    useExtensionStore.getState().install(
      manifest({ settings: [{ key: 'loud', label: 'Loud', type: 'boolean', default: true }] }),
    );

    useExtensionStore.getState().setSetting('test-ext', 'loud', false);

    expect(useExtensionStore.getState().installed[0].settings.loud).toBe(false);
  });

  it('removes an extension and everything it was granted', () => {
    useExtensionStore.getState().install(manifest());
    useExtensionStore.getState().setEnabled('test-ext', true);

    useExtensionStore.getState().uninstall('test-ext');

    expect(useExtensionStore.getState().installed).toHaveLength(0);
    expect(useExtensionStore.getState().grantedTo('test-ext')).toEqual([]);
  });
});
