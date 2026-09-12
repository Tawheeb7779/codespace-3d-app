import { describe, expect, it } from 'vitest';
import { connectionStatus } from '@/lib/ai/connection';
import type { ProviderConfig } from '@/lib/ai/provider';

/**
 * The four answers to "can the assistant send a request", instead of one
 * boolean that is wrong three ways.
 *
 * `connected: false` covers three situations needing three different actions:
 * choose a provider, paste a key, or do nothing because the deployment holds
 * the credential. Somebody shown "not connected" on the third goes looking for
 * a key that cannot exist in a browser — and concludes the feature is broken.
 */

const provider = (kind: ProviderConfig['kind']): ProviderConfig =>
  ({ kind, model: 'm', baseUrl: '' }) as ProviderConfig;

describe('nothing chosen', () => {
  it('is none, and says to choose one', () => {
    const status = connectionStatus(provider('none'), false, false);

    expect(status.state).toBe('none');
    expect(status.usable).toBe(false);
    expect(status.action).toMatch(/choose a provider/i);
  });

  it('is still none even where a hosted key exists', () => {
    expect(connectionStatus(provider('none'), true, true).state).toBe('none');
  });
});

describe('a provider that needs a key it does not have', () => {
  it('is needs-key for anthropic', () => {
    const status = connectionStatus(provider('anthropic'), false, false);

    expect(status.state).toBe('needs-key');
    expect(status.usable).toBe(false);
    expect(status.action).toMatch(/anthropic/i);
  });

  it('is needs-key for gemini with no hosted key', () => {
    const status = connectionStatus(provider('gemini'), false, false);

    expect(status.state).toBe('needs-key');
    expect(status.action).toMatch(/gemini/i);
  });

  it('never reads as "a an"', () => {
    expect(connectionStatus(provider('anthropic'), false, false).action).not.toMatch(/\ba an\b/);
  });
});

describe('a key held by the deployment', () => {
  /** Nothing is missing here, and asking for a key would be asking for nothing. */
  it('is hosted and usable with no key in the browser', () => {
    const status = connectionStatus(provider('gemini'), false, true);

    expect(status.state).toBe('hosted');
    expect(status.usable).toBe(true);
    expect(status.action).toBe('');
  });

  it('does not claim to be hosted for another provider', () => {
    expect(connectionStatus(provider('anthropic'), false, true).state).toBe('needs-key');
  });
});

describe('ready', () => {
  it('is ready once a key is present', () => {
    const status = connectionStatus(provider('anthropic'), true, false);

    expect(status.state).toBe('ready');
    expect(status.usable).toBe(true);
  });

  /** A local model server needs no credential, and blocking it would be wrong. */
  it('lets an OpenAI-compatible endpoint run without a key', () => {
    const status = connectionStatus(provider('openai'), false, false);

    expect(status.state).toBe('ready');
    expect(status.usable).toBe(true);
    expect(status.action).toMatch(/if your endpoint needs a key/i);
  });

  it('says nothing extra once a key is there', () => {
    expect(connectionStatus(provider('openai'), true, false).action).toBe('');
  });
});

describe('the shape of the answer', () => {
  it.each([
    [provider('none'), false, false],
    [provider('anthropic'), false, false],
    [provider('gemini'), false, true],
    [provider('anthropic'), true, false],
  ])('always carries a label', (config, key, hosted) => {
    expect(connectionStatus(config, key, hosted).label.length).toBeGreaterThan(0);
  });

  it('is usable exactly when it is hosted or ready', () => {
    const cases: Array<[ProviderConfig, boolean, boolean]> = [
      [provider('none'), false, false],
      [provider('anthropic'), false, false],
      [provider('gemini'), false, true],
      [provider('anthropic'), true, false],
      [provider('openai'), false, false],
    ];

    for (const [config, key, hosted] of cases) {
      const status = connectionStatus(config, key, hosted);
      expect(status.usable).toBe(status.state === 'hosted' || status.state === 'ready');
    }
  });
});
