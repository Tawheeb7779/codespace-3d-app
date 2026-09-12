import { ProviderError, REQUEST_TIMEOUT_MS } from '@/lib/ai/provider';
import { supportsDiscovery, type ProviderRecord } from '@/lib/ai/providers';

/**
 * Asking a provider what it offers, instead of telling the user what we think
 * it offers.
 *
 * The product used to present the model as a free-text box: whatever the user
 * typed was sent, and a name that no longer existed came back as a 404 halfway
 * through a task. The obvious fix — check in a catalogue — is worse than it
 * looks. Model names turn over constantly, and a checked-in list is not merely
 * stale but actively wrong: it offers the user a model that cannot be called,
 * with this software's authority behind it.
 *
 * So nothing here knows a model id. The provider is asked, at the moment a key
 * is configured, over the same OpenAI-compatible shape its chat endpoint uses:
 * `GET {baseUrl}/models`. What comes back is normalised and shown. If the
 * provider offers fifty, fifty appear; if it offers five, five appear; if it
 * cannot be asked, the picker says that rather than showing an empty list as
 * though the account were empty.
 *
 * **What is never done here:** inventing an id, inferring a capability from a
 * name, or calling something free because it sounds free. Every field a
 * provider does not supply stays `null`, and `null` is rendered as unknown
 * rather than as a default that reads like a fact.
 */

/**
 * What a model costs, as far as can honestly be said.
 *
 * The distinction between the first two is the point. `free` is only used when
 * a provider states a price and that price is zero — a property of the model,
 * on the wire, from the provider. `free-tier` is an account having an
 * allowance, which is not a model fact and not something this software can
 * promise: the same model is free until a quota runs out and then is not.
 */
export type CostClass =
  /** The provider quoted a price of zero for this model. */
  | 'free'
  /** The provider offers an allowance per account, not a zero price. */
  | 'free-tier'
  /** The provider quoted a price above zero. */
  | 'paid'
  /** The provider said nothing about price, so neither does this. */
  | 'unknown';

/** Per-token prices as the provider quoted them, or null when it did not. */
export interface ModelPricing {
  /** Price per input token, in the provider's own units. */
  input: number | null;
  /** Price per output token, in the provider's own units. */
  output: number | null;
}

export interface ModelRecord {
  providerId: string;
  /** Exactly as the provider returned it. Never rewritten, never guessed. */
  modelId: string;
  displayName: string;
  /** Null when the provider did not say. Not defaulted to a plausible number. */
  contextLength: number | null;
  /** Null when the provider did not say whether it can call tools. */
  toolCalling: boolean | null;
  /** Null when the provider did not say whether it can stream. */
  streaming: boolean | null;
  pricing: ModelPricing;
  cost: CostClass;
  /** False only when the provider itself reported the model unavailable. */
  available: boolean;
  /** Whatever else the provider said, kept for display. Never a credential. */
  providerMetadata: Record<string, unknown>;
}

export interface DiscoveryResult {
  providerId: string;
  models: ModelRecord[];
  /** When this was fetched, so the UI can say how old it is. */
  fetchedAt: number;
}

/** How long a list is reused before the provider is asked again. */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** Refuses a response large enough to be a mistake rather than a model list. */
export const MAX_DISCOVERED_MODELS = 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Prices commonly arrive as decimal strings, which is why "0" must parse
  // rather than being discarded as the wrong type — it is the free case.
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The first key present, so one reader handles the field names in use. */
function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

/**
 * Prices, when the provider quotes them.
 *
 * Only read for a provider whose list carries prices. Asking a provider that
 * does not quote them would produce nulls that then look like "we checked and
 * there is no price", which is a different claim from "we did not check".
 */
function readPricing(entry: Record<string, unknown>): ModelPricing {
  const quoted = asRecord(entry.pricing);
  if (!quoted) return { input: null, output: null };
  return {
    input: asFiniteNumber(pick(quoted, ['prompt', 'input', 'input_tokens'])),
    output: asFiniteNumber(pick(quoted, ['completion', 'output', 'output_tokens'])),
  };
}

/**
 * What this costs, from what the provider actually said.
 *
 * Nothing about the name is consulted. A model called `...-free` is not free,
 * and a provider that renames a paid model would otherwise change this
 * software's answer about its price.
 */
export function classifyCost(provider: ProviderRecord, pricing: ModelPricing): CostClass {
  if (provider.pricing === 'account') {
    // The provider's own terms, which are about the account rather than the
    // model. `anthropic` states no free tier; the others state one.
    return provider.id === 'anthropic' ? 'paid' : 'free-tier';
  }
  const { input, output } = pricing;
  if (input === null && output === null) return 'unknown';
  // Both sides must be free for the model to be free: a zero prompt price with
  // a charged completion is a paid model with a discounted half.
  if ((input ?? 0) <= 0 && (output ?? 0) <= 0) return 'free';
  return 'paid';
}

/**
 * Turn one entry from a provider's list into a record, or nothing.
 *
 * An entry with no usable id is dropped rather than repaired. A model this
 * cannot name is a model it cannot call, and inventing a name for it would put
 * an unusable option in front of the user.
 */
export function normalizeModel(provider: ProviderRecord, raw: unknown): ModelRecord | null {
  const entry = asRecord(raw);
  if (!entry) return null;

  const id = pick(entry, ['id', 'name', 'model']);
  if (typeof id !== 'string' || !id.trim()) return null;
  const modelId = id.trim();

  const label = pick(entry, ['display_name', 'displayName', 'name']);
  const contextLength = asFiniteNumber(
    pick(entry, ['context_length', 'contextLength', 'context_window', 'max_context_length']),
  );

  // Tool and stream support is only claimed when the provider listed it. An
  // absent `supported_parameters` means unknown, not unsupported: most
  // providers simply do not report capabilities, and answering "no" for them
  // would hide models that do in fact call tools.
  const parameters = pick(entry, ['supported_parameters', 'supportedParameters']);
  const declared = Array.isArray(parameters)
    ? parameters.filter((value): value is string => typeof value === 'string')
    : null;
  const toolCalling = declared ? declared.includes('tools') || declared.includes('tool_choice') : null;
  const streaming = declared ? declared.includes('stream') : null;

  const pricing = provider.pricing === 'per-model' ? readPricing(entry) : { input: null, output: null };

  // `active: false` is the only thing that makes a model unavailable — a
  // provider saying so. Absence of the field is not a claim either way.
  const active = pick(entry, ['active', 'available']);
  const available = active === undefined ? true : active !== false;

  return {
    providerId: provider.id,
    modelId,
    displayName: typeof label === 'string' && label.trim() ? label.trim() : modelId,
    contextLength,
    toolCalling,
    streaming,
    pricing,
    cost: classifyCost(provider, pricing),
    available,
    providerMetadata: metadataOf(entry),
  };
}

/** Keys worth showing, and nothing shaped like a credential. */
const METADATA_KEYS = ['description', 'owned_by', 'created', 'architecture', 'top_provider'];
const CREDENTIAL_SHAPED = /key|token|secret|authorization|password|credential/i;

function metadataOf(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of METADATA_KEYS) {
    if (CREDENTIAL_SHAPED.test(key)) continue;
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

/**
 * Every model in a provider's answer, normalised.
 *
 * Ordered by the provider's own ordering, deduplicated by id, and capped: a
 * response with more entries than {@link MAX_DISCOVERED_MODELS} is a response
 * to be suspicious of, not one to render.
 */
export function normalizeModelList(provider: ProviderRecord, payload: unknown): ModelRecord[] {
  const body = asRecord(payload);
  // `{ data: [...] }` is the OpenAI shape every provider here follows; a bare
  // array is accepted because some gateways return one.
  const list = Array.isArray(payload) ? payload : Array.isArray(body?.data) ? body.data : null;
  if (!list) {
    throw new ProviderError(
      `${provider.label} answered its model list in a shape TA CODE could not read.`,
      'malformed',
    );
  }

  const seen = new Set<string>();
  const models: ModelRecord[] = [];
  for (const entry of list.slice(0, MAX_DISCOVERED_MODELS)) {
    const model = normalizeModel(provider, entry);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }
  return models;
}

/** Host only, so a base URL carrying a query string cannot reach a message. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured endpoint';
  }
}

export interface DiscoveryRequest {
  provider: ProviderRecord;
  /** Overrides the record's own base URL, for a proxy or a local server. */
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Test seam. Defaults to the platform's. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask a provider for its models.
 *
 * The failure kinds are the ones `provider.ts` already defines, so a discovery
 * failure reads the same as a completion failure and the UI needs no second
 * vocabulary for it. The key is sent in a header and never in the URL, and no
 * message here contains it — a 401 says the host refused the key, not what the
 * key was.
 */
export async function discoverModels(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const { provider, signal, fetchImpl = fetch } = request;

  if (!supportsDiscovery(provider)) {
    throw new ProviderError(
      `${provider.label} does not publish a model list, so its model has to be entered by hand.`,
      'not-configured',
    );
  }

  const base = (request.baseUrl ?? provider.baseUrl).trim().replace(/\/+$/, '');
  if (!base) {
    throw new ProviderError(
      `${provider.label} needs a base URL before its models can be listed.`,
      'not-configured',
    );
  }
  if (provider.requiresUserApiKey && !request.apiKey) {
    throw new ProviderError(
      `${provider.label} needs an API key before its models can be listed.`,
      'not-configured',
    );
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ProviderError('Listing models was cancelled.', 'request');
    if (controller.signal.aborted) {
      throw new ProviderError(`${safeHost(base)} did not answer in time.`, 'timeout');
    }
    void error;
    throw new ProviderError(`Could not reach ${safeHost(base)}.`, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }

  if (!response.ok) throw failureFor(response, provider, base);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError(
      `${provider.label} answered its model list with something that is not JSON.`,
      'malformed',
    );
  }

  return {
    providerId: provider.id,
    models: normalizeModelList(provider, payload),
    fetchedAt: Date.now(),
  };
}

/**
 * The provider's status code, as one of the kinds the rest of the AI code
 * already handles. Nothing from the body is echoed: an error page is not a
 * message written for this user.
 */
function failureFor(response: Response, provider: ProviderRecord, base: string): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      `${safeHost(base)} refused the API key. Check it in ${provider.label}'s console.`,
      'unauthorized',
    );
  }
  if (response.status === 429) {
    const header = response.headers?.get?.('retry-after');
    const seconds = header ? Number(header) : NaN;
    return new ProviderError(
      `${provider.label} is rate limiting this key.`,
      'rate-limited',
      Number.isFinite(seconds) ? Math.floor(Date.now() / 1000 + seconds) : null,
    );
  }
  if (response.status === 404) {
    return new ProviderError(
      `${safeHost(base)} has no model list at /models. Enter the model by hand.`,
      'not-configured',
    );
  }
  if (response.status >= 500) {
    return new ProviderError(`${provider.label} failed to list its models.`, 'server');
  }
  return new ProviderError(
    `${provider.label} refused to list its models (${response.status}).`,
    'request',
  );
}

/**
 * One list per provider, reused for {@link DISCOVERY_TTL_MS}.
 *
 * Keyed by provider *and* base URL, so pointing the generic record at a
 * different server is a different list rather than the previous server's
 * answer. Nothing here is persisted: a cached list is a convenience within a
 * session, and a stale one across sessions would be the catalogue problem
 * again in a different place.
 */
const cache = new Map<string, DiscoveryResult>();

const cacheKey = (providerId: string, baseUrl: string) =>
  `${providerId} ${baseUrl.trim().replace(/\/+$/, '')}`;

export interface CachedDiscoveryRequest extends DiscoveryRequest {
  /** Ask the provider again even if a recent answer is held. */
  refresh?: boolean;
}

export async function discoverModelsCached(
  request: CachedDiscoveryRequest,
): Promise<DiscoveryResult> {
  const base = (request.baseUrl ?? request.provider.baseUrl) || '';
  const key = cacheKey(request.provider.id, base);
  const held = cache.get(key);
  if (!request.refresh && held && Date.now() - held.fetchedAt < DISCOVERY_TTL_MS) return held;

  const result = await discoverModels(request);
  cache.set(key, result);
  return result;
}

/** Drop held lists. For tests, for a sign-out, and for an explicit refresh. */
export function clearDiscoveryCache(): void {
  cache.clear();
}

export interface ModelFilter {
  /** Matched against the id and the display name, case-insensitively. */
  query?: string;
  providerId?: string;
  cost?: CostClass[];
  /** Keep only models the provider said can call tools. */
  toolCallingOnly?: boolean;
  /** Keep only models the provider reported as available. */
  availableOnly?: boolean;
}

/**
 * The picker's filtering, as a function so it is testable away from the UI.
 *
 * `toolCallingOnly` keeps models whose support is *unknown*. The agent needs
 * tools, and most providers do not report capabilities at all — excluding
 * unknowns would empty the list for those providers and hide models that work.
 * An unknown is shown as unknown and left to the user.
 */
export function filterModels(models: readonly ModelRecord[], filter: ModelFilter): ModelRecord[] {
  const needle = filter.query?.trim().toLowerCase() ?? '';
  return models.filter((model) => {
    if (needle) {
      const haystack = `${model.modelId} ${model.displayName}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filter.providerId && model.providerId !== filter.providerId) return false;
    if (filter.cost?.length && !filter.cost.includes(model.cost)) return false;
    if (filter.toolCallingOnly && model.toolCalling === false) return false;
    if (filter.availableOnly && !model.available) return false;
    return true;
  });
}
