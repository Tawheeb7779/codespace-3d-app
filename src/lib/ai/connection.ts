import type { ProviderConfig } from '@/lib/ai/provider';

/**
 * Whether the assistant can actually send a request, in the four answers that
 * are true rather than the one that is convenient.
 *
 * A boolean `connected` collapses three different situations into "not
 * connected", and they need three different things from the user: choosing a
 * provider, pasting a key, or nothing at all because the deployment holds the
 * credential. A person shown "not connected" on the third one goes looking for
 * a key that does not exist and cannot exist in a browser.
 *
 * So the states are named, and each carries what to do about it.
 */
export type ConnectionState =
  /** No provider chosen yet. */
  | 'none'
  /** A provider is chosen and the credential it needs is missing. */
  | 'needs-key'
  /** The deployment holds the credential; the browser has nothing to supply. */
  | 'hosted'
  /** A credential is present and requests can be sent. */
  | 'ready';

export interface ConnectionStatus {
  state: ConnectionState;
  /** Whether a request can be attempted at all. */
  usable: boolean;
  label: string;
  /** What the user should do, or empty when there is nothing to do. */
  action: string;
}

/**
 * Read the connection state from the configuration as it stands.
 *
 * `hostedAvailable` is passed in rather than read here so this stays a pure
 * function of its inputs — the panel knows whether the deployment offers a
 * hosted key, and this module should not need to.
 */
export function connectionStatus(
  provider: ProviderConfig,
  apiKeyPresent: boolean,
  hostedAvailable: boolean,
): ConnectionStatus {
  if (provider.kind === 'none') {
    return {
      state: 'none',
      usable: false,
      // The wording an existing browser test asserts, and the wording the
      // product shipped with. The four-state model is the change here; the
      // user-visible copy was not, and should not have been.
      label: 'No model provider connected',
      action: 'Choose a provider to start.',
    };
  }

  // The deployment's own key, behind its own sign-in. There is nothing in the
  // browser to be missing, so asking for a key here would be asking for
  // something that cannot exist.
  if (provider.kind === 'gemini' && hostedAvailable) {
    return {
      state: 'hosted',
      usable: true,
      label: 'Provided by this deployment',
      action: '',
    };
  }

  /*
   * An OpenAI-compatible endpoint may legitimately need no key.
   *
   * A local model server on localhost is the ordinary case, and demanding a
   * credential there would block a setup that works. The request will say so
   * itself if the endpoint does want one.
   */
  if (provider.kind === 'openai' && !apiKeyPresent) {
    return {
      state: 'ready',
      usable: true,
      label: 'Connected without a key',
      action: 'If your endpoint needs a key, add one — requests will fail without it.',
    };
  }

  if (!apiKeyPresent) {
    return {
      state: 'needs-key',
      usable: false,
      label: 'Key needed',
      action: `Add a ${provider.kind === 'anthropic' ? 'an Anthropic' : 'Gemini'} API key to send requests.`.replace(
        'a an',
        'an',
      ),
    };
  }

  return { state: 'ready', usable: true, label: 'Connected', action: '' };
}
