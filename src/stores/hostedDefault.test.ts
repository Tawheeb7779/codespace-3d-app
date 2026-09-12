// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What a user who has never chosen a provider is asked for.
 *
 * On a deployment that hosts the assistant the answer should be nothing: the
 * server holds the credential, checks the session and meters the call, so
 * there is no key for the person to supply and no decision for them to make.
 * They were being asked anyway — the default provider was `none`, so the panel
 * opened on "No model provider connected" and the only route forward was a
 * dialog about providers and API keys.
 *
 * The other half matters just as much. In Local Development Mode there is no
 * server between the browser and a provider, so the honest default is still
 * bring-your-own-key. Defaulting to the hosted provider there would claim a
 * capability that is not present and fail at the first request.
 */

const hosted = { available: false };

vi.mock('@/lib/ai/hosted', () => ({
  hostedAiAvailable: () => hosted.available,
  hostedResolverFor: () => null,
  aiTransport: () => (hosted.available ? 'hosted' : 'byok'),
  hostedGeminiEndpoint: async () => null,
}));

/** Imported fresh each time, so the module-level default is recomputed. */
async function initialProvider() {
  vi.resetModules();
  const module = await import('@/stores/aiStore');
  return module.initialProvider();
}

afterEach(() => {
  hosted.available = false;
});

describe('a deployment that hosts the assistant', () => {
  it('starts on the hosted provider, so nobody is asked to connect one', async () => {
    hosted.available = true;

    expect(await initialProvider()).toMatchObject({ kind: 'gemini' });
  });

  it('starts with a model, so the first request has one to send', async () => {
    hosted.available = true;
    const provider = await initialProvider();

    expect(provider.model.trim().length).toBeGreaterThan(0);
  });

  /** The credential is the server's; nothing about it belongs in the browser. */
  it('carries no base URL and no key of its own', async () => {
    hosted.available = true;
    const provider = await initialProvider();

    expect(provider.baseUrl).toBe('');
    expect(JSON.stringify(provider)).not.toMatch(/key/i);
  });
});

describe('local development mode', () => {
  it('keeps the bring-your-own-key default rather than claiming a server', async () => {
    hosted.available = false;

    expect(await initialProvider()).toMatchObject({ kind: 'none' });
  });

  /**
   * The distinction this whole change rests on: the default follows the real
   * deployment, and is not a state the UI simply asserts.
   */
  it('differs from the hosted default, and only because the deployment does', async () => {
    hosted.available = false;
    const local = await initialProvider();
    hosted.available = true;
    const server = await initialProvider();

    expect(local.kind).not.toBe(server.kind);
  });
});
