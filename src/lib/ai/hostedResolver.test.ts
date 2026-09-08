import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which transport a provider gets, and what the browser puts in the request.
 *
 * Split from the transport tests because this half is about the Supabase
 * client, which has to be mocked; the other half stubs `fetch` and needs no
 * mock at all.
 */

const getSession = vi.fn();
const state = { configured: true };

vi.mock('@/lib/supabase', () => ({
  get isSupabaseConfigured() {
    return state.configured;
  },
  get supabase() {
    return state.configured ? { auth: { getSession } } : null;
  },
  functionUrl: (name: string) =>
    state.configured ? `https://project.supabase.co/functions/v1/${name}` : null,
}));

const signedIn = () =>
  getSession.mockResolvedValue({ data: { session: { access_token: 'session-token' } } });
const signedOut = () => getSession.mockResolvedValue({ data: { session: null } });

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  state.configured = true;
});

const load = () => import('@/lib/ai/hosted');

describe('a deployment that hosts the assistant', () => {
  it('sends the signed-in session, and nothing else', async () => {
    signedIn();
    const { hostedGeminiEndpoint } = await load();

    const endpoint = await hostedGeminiEndpoint();

    expect(endpoint?.url).toBe('https://project.supabase.co/functions/v1/ai-proxy');
    expect(endpoint?.headers.authorization).toBe('Bearer session-token');
  });

  /**
   * A signed-out browser has nothing to prove who it is, so there is nothing to
   * send. Null rather than a throw: the provider then reports "not connected",
   * which is the truth, instead of a transport error.
   */
  it('has no endpoint for a signed-out browser', async () => {
    signedOut();
    const { hostedGeminiEndpoint } = await load();

    expect(await hostedGeminiEndpoint()).toBeNull();
  });

  it('asks for the session on every call, so a long turn refreshes it', async () => {
    signedIn();
    const { hostedGeminiEndpoint } = await load();

    await hostedGeminiEndpoint();
    await hostedGeminiEndpoint();

    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('hosts Gemini and nothing else', async () => {
    const { hostedResolverFor } = await load();

    expect(hostedResolverFor('gemini')).not.toBeNull();
    for (const kind of ['anthropic', 'openai', 'none']) {
      expect(hostedResolverFor(kind)).toBeNull();
    }
  });

  it('reports itself available, so the panel can stop asking for a key', async () => {
    const { aiTransport, hostedAiAvailable } = await load();

    expect(hostedAiAvailable()).toBe(true);
    expect(aiTransport()).toBe('hosted');
  });
});

describe('Local Development Mode', () => {
  beforeEach(() => {
    state.configured = false;
  });

  it('has nothing to host with, so Gemini stays bring-your-own-key', async () => {
    const { aiTransport, hostedAiAvailable, hostedResolverFor } = await load();

    expect(hostedAiAvailable()).toBe(false);
    expect(aiTransport()).toBe('byok');
    expect(hostedResolverFor('gemini')).toBeNull();
  });

  it('resolves no endpoint even if asked directly', async () => {
    const { hostedGeminiEndpoint } = await load();

    expect(await hostedGeminiEndpoint()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });
});
