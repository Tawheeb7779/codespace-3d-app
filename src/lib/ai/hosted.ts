import type { HostedEndpoint } from '@/lib/ai/provider';
import { functionUrl, isSupabaseConfigured, supabase } from '@/lib/supabase';

/**
 * How an assistant request leaves the browser.
 *
 * The same two-transport shape the GitHub integration uses, for the same
 * reason, and which one is active is a deployment property rather than a
 * behavioural one:
 *
 *   `hosted` — the request goes to TA CODE's `ai-proxy` Edge Function, which
 *              holds the deployment's Gemini key and checks the caller's
 *              session before spending it. Nothing secret is in the browser
 *              and nobody is asked for a key. This is what a deployed TA CODE
 *              runs.
 *
 *   `byok`   — Local Development Mode, where there is no server to mediate and
 *              no accounts to authenticate. The developer supplies their own
 *              key; it lives in `sessionStorage` for the tab. The UI says which
 *              mode it is in rather than implying the local path is the hosted
 *              one.
 *
 * Anthropic and any OpenAI-compatible endpoint stay bring-your-own-key in both
 * modes: the deployment holds one Gemini credential, not one of everything.
 */
export type AiTransport = 'hosted' | 'byok';

/** Whether the shared assistant is available at all in this deployment. */
export function hostedAiAvailable(): boolean {
  return isSupabaseConfigured;
}

export function aiTransport(): AiTransport {
  return hostedAiAvailable() ? 'hosted' : 'byok';
}

/**
 * The signed-in caller's endpoint, or null when there is nobody to bill.
 *
 * Returns null rather than throwing so a signed-out browser falls through to
 * the provider's own "not connected" message instead of a transport error, and
 * so the resolver can be called on every step of an agent turn without a
 * try/catch at each one.
 *
 * The token is read fresh each time: `getSession()` refreshes an access token
 * that is close to expiry, which matters over a turn of a dozen calls. What
 * crosses is proof of identity — the Gemini key is on the other side of the
 * function and never reaches this file.
 */
export async function hostedGeminiEndpoint(): Promise<HostedEndpoint | null> {
  if (!supabase) return null;
  const url = functionUrl('ai-proxy');
  if (!url) return null;

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;

  return {
    url,
    headers: {
      authorization: `Bearer ${token}`,
      // The gateway routes on this; it is the publishable anon key, which is in
      // the bundle by design and grants nothing on its own.
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
    },
  };
}

/**
 * The resolver to hand the agent for a given provider.
 *
 * Only Gemini is hosted, and only where a deployment exists to host it. Every
 * other provider — and Gemini in Local Development Mode — resolves to null and
 * takes the bring-your-own-key path unchanged.
 */
export function hostedResolverFor(kind: string): (() => Promise<HostedEndpoint | null>) | null {
  if (kind !== 'gemini' || !hostedAiAvailable()) return null;
  return hostedGeminiEndpoint;
}
