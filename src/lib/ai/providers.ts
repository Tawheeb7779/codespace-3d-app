import { GEMINI_BASE_URL, type ProviderKind } from '@/lib/ai/provider';

/**
 * Which providers TA CODE can talk to, as data.
 *
 * The transport already existed and is not duplicated here: `provider.ts` has
 * one OpenAI-compatible caller and one Anthropic caller, and every record below
 * names which of the two carries it. That is the whole reason Groq and
 * OpenRouter need no new adapter — they speak the OpenAI chat-completions
 * format, so they are a base URL and a set of facts about the account, not a
 * second implementation.
 *
 * What this file adds is the part that was missing: the facts. Before it, a
 * provider was a `kind` and the model was a free-text box the user typed into,
 * so nothing in the product knew what a model could do, what it cost, or
 * whether the name in the box existed at all.
 *
 * **No model IDs live here.** Model names turn over faster than any file can
 * track — a provider deprecated two of its most-used models weeks before this
 * was written — so a checked-in catalogue is wrong shortly after it is written
 * and wrong in the worst way: a dead id is a request that 404s, presented to
 * the user as a model they may select. Models come from the provider at
 * runtime; see `modelDiscovery.ts`. This file describes only what is structural
 * and verifiable from the code: where a provider lives, which transport reaches
 * it, whether it can be asked what it offers, and whether its answer carries
 * prices.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'openrouter';

/**
 * How a provider answers "what models do you have?".
 *
 * `openai-compatible` means `GET {baseUrl}/models` returning `{ data: [...] }`
 * with a bearer token — the shape the OpenAI SDK defined and the others adopted.
 * `none` means this provider is not asked, and the picker says so rather than
 * showing an empty list as though the account had no models.
 */
export type DiscoveryStyle = 'openai-compatible' | 'none';

/**
 * Whether the provider's model list carries prices.
 *
 * This decides whether free/paid can be *read* or must be left unknown, and it
 * is the difference between a classification and a guess. See
 * `classifyCost` in `modelDiscovery.ts`.
 */
export type PricingSource =
  /** Per-model prices in the discovery response. Cost is read, not inferred. */
  | 'per-model'
  /** No prices on the wire. What the account is charged is not a model fact. */
  | 'account';

export interface ProviderRecord {
  id: ProviderId;
  label: string;
  /**
   * Which existing transport in `provider.ts` carries this provider.
   *
   * Deliberately not one adapter per provider: three of these are the same
   * request with a different host, and writing three copies of it would be
   * three places for a bug to live.
   */
  kind: ProviderKind;
  /**
   * The API root, or empty when the user supplies it.
   *
   * Empty is not a missing value — it is the generic OpenAI-compatible record,
   * which exists so a local model server or a corporate proxy can be used
   * without this file knowing about it.
   */
  baseUrl: string;
  discovery: DiscoveryStyle;
  pricing: PricingSource;
  /** Whether a request needs a key the user pastes in. */
  requiresUserApiKey: boolean;
  /**
   * What the provider says about free access, in the provider's own terms.
   *
   * Never a promise. A free allowance is a property of an account and a moment,
   * not of this software, and it is stated as the thing to go and read rather
   * than as a quantity this file claims to know.
   */
  accessNote: string;
  /** Where the user goes to get a key or read the current terms. */
  consoleUrl: string;
}

/**
 * The providers, in the order the picker offers them.
 *
 * Anthropic is not asked for its model list: its models endpoint authenticates
 * with `x-api-key` and a version header rather than a bearer token, so it is
 * not the same request, and claiming discovery here would mean writing a second
 * discovery path for one provider. It is marked `none` honestly, and its model
 * is typed in — which is what the product did for every provider before this.
 */
export const PROVIDERS: readonly ProviderRecord[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    discovery: 'openai-compatible',
    // The one provider here whose list carries prices, which is why it is the
    // only one where free and paid are read rather than left unknown.
    pricing: 'per-model',
    requiresUserApiKey: true,
    accessNote:
      'Routes to many providers under one key. Some models are priced at zero; the rest are paid, and the list says which is which.',
    consoleUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    discovery: 'openai-compatible',
    // No prices on the wire, so what an account is charged cannot be read from
    // a model record. Reported as a free tier, never as free.
    pricing: 'account',
    requiresUserApiKey: true,
    accessNote:
      'Offers a free developer tier with rate limits set per account. The limits are not in the model list, so check the console for what your key allows.',
    consoleUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: GEMINI_BASE_URL,
    discovery: 'openai-compatible',
    pricing: 'account',
    requiresUserApiKey: true,
    accessNote:
      'Has a free tier whose quota depends on the model and the project. This deployment may also provide Gemini itself, in which case no key is needed.',
    consoleUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: '',
    // Its model list is a different request — `x-api-key` and a version
    // header, not a bearer token — so it is not asked rather than half-asked.
    discovery: 'none',
    pricing: 'account',
    requiresUserApiKey: true,
    accessNote: 'Paid API access. Usage is billed per token; there is no free tier.',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible endpoint',
    kind: 'openai',
    baseUrl: '',
    discovery: 'openai-compatible',
    pricing: 'account',
    // A local model server on localhost commonly needs none, which is why the
    // connection model already treats a missing key here as usable.
    requiresUserApiKey: false,
    accessNote:
      'Any server speaking the OpenAI chat-completions API: a local model, a gateway, or a proxy. What it costs is between you and it.',
    consoleUrl: '',
  },
];

export function providerById(id: string): ProviderRecord | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The record for a bare `ProviderKind`, for code that still speaks in kinds.
 *
 * Two records share the `openai` kind, so this prefers the generic one: a kind
 * alone does not say whether the user meant Groq, OpenRouter or their own
 * server, and the base URL is what distinguishes them.
 */
export function providerForKind(kind: ProviderKind): ProviderRecord | undefined {
  if (kind === 'openai') return providerById('openai');
  return PROVIDERS.find((provider) => provider.kind === kind);
}

/**
 * Which provider a configuration is actually pointed at.
 *
 * The base URL decides, because the kind cannot: Groq, OpenRouter and a local
 * server are all `openai`. Matching on the URL is what lets the picker say
 * "Groq" instead of "OpenAI-compatible endpoint" for a Groq key.
 */
export function providerForConfig(config: { kind: ProviderKind; baseUrl: string }): ProviderRecord | undefined {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  if (base) {
    const named = PROVIDERS.find(
      (provider) => provider.baseUrl && provider.baseUrl.replace(/\/+$/, '') === base,
    );
    if (named) return named;
  }
  return providerForKind(config.kind);
}

/** Whether this provider can be asked what it offers. */
export function supportsDiscovery(provider: ProviderRecord): boolean {
  return provider.discovery === 'openai-compatible';
}
