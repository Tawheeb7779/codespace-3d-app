import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@/lib/ai/provider';
import {
  PROVIDERS,
  providerById,
  providerForConfig,
  providerForKind,
  supportsDiscovery,
} from '@/lib/ai/providers';
import {
  MAX_DISCOVERED_MODELS,
  classifyCost,
  clearDiscoveryCache,
  discoverModels,
  discoverModelsCached,
  filterModels,
  normalizeModel,
  normalizeModelList,
  type ModelRecord,
} from '@/lib/ai/modelDiscovery';

/**
 * Asking the provider, and believing only what it answers.
 *
 * The model used to be a free-text box: whatever was typed got sent, and a name
 * that no longer existed failed mid-task. A checked-in catalogue would replace
 * that with a worse problem — model names turn over constantly, so the list is
 * wrong soon after it is written, and a dead id is offered to the user with this
 * software's authority behind it.
 *
 * So these tests are mostly about restraint. What a provider does not say, this
 * does not claim: no id is invented, no capability is inferred from a name, and
 * nothing is called free unless a provider quoted a price of zero.
 */

const openrouter = providerById('openrouter')!;
const groq = providerById('groq')!;
const anthropic = providerById('anthropic')!;
const generic = providerById('openai')!;

afterEach(() => {
  clearDiscoveryCache();
  vi.restoreAllMocks();
});

const answering = (payload: unknown, init: { status?: number; headers?: Headers } = {}) =>
  vi.fn(async () =>
    ({
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: init.headers ?? new Headers(),
      json: async () => payload,
    }) as unknown as Response,
  );

describe('the provider registry', () => {
  it('registers every provider the transports can actually carry', () => {
    for (const provider of PROVIDERS) {
      expect(['anthropic', 'openai', 'gemini']).toContain(provider.kind);
    }
  });

  it('ships no model ids, because they are not knowable here', () => {
    const serialised = JSON.stringify(PROVIDERS);

    expect(serialised).not.toMatch(/gpt-|claude-|gemini-\d|llama-/i);
  });

  it('gives every provider somewhere to go for a key or the terms', () => {
    for (const provider of PROVIDERS) {
      if (provider.requiresUserApiKey) expect(provider.consoleUrl).toMatch(/^https:\/\//);
    }
  });

  /** The base URL disambiguates; the kind cannot, since three share `openai`. */
  it('names the real provider behind an OpenAI-compatible base URL', () => {
    expect(providerForConfig({ kind: 'openai', baseUrl: groq.baseUrl })?.id).toBe('groq');
    expect(providerForConfig({ kind: 'openai', baseUrl: openrouter.baseUrl })?.id).toBe('openrouter');
    expect(providerForConfig({ kind: 'openai', baseUrl: `${groq.baseUrl}/` })?.id).toBe('groq');
  });

  it('falls back to the generic record for an unknown endpoint', () => {
    expect(providerForConfig({ kind: 'openai', baseUrl: 'https://my-gateway.internal/v1' })?.id).toBe(
      'openai',
    );
    expect(providerForKind('openai')?.id).toBe('openai');
  });

  it('reports which providers can be asked for a list', () => {
    expect(supportsDiscovery(openrouter)).toBe(true);
    expect(supportsDiscovery(groq)).toBe(true);
    // Its model list is a different request, so it is not asked at all.
    expect(supportsDiscovery(anthropic)).toBe(false);
  });
});

describe('normalising one model', () => {
  it('keeps the provider’s id exactly as given', () => {
    const model = normalizeModel(groq, { id: 'some-provider/model-v2' });

    expect(model?.modelId).toBe('some-provider/model-v2');
  });

  /** A model that cannot be named cannot be called. */
  it('drops an entry with no usable id rather than inventing one', () => {
    expect(normalizeModel(groq, { context_length: 8192 })).toBeNull();
    expect(normalizeModel(groq, { id: '   ' })).toBeNull();
    expect(normalizeModel(groq, 'not an object')).toBeNull();
    expect(normalizeModel(groq, null)).toBeNull();
  });

  it('falls back to the id for a display name, never to a prettier guess', () => {
    expect(normalizeModel(groq, { id: 'raw-id' })?.displayName).toBe('raw-id');
    expect(normalizeModel(groq, { id: 'raw-id', display_name: 'Nice Name' })?.displayName).toBe(
      'Nice Name',
    );
  });

  it('leaves everything the provider did not say as unknown', () => {
    const model = normalizeModel(groq, { id: 'bare' })!;

    expect(model.contextLength).toBeNull();
    expect(model.toolCalling).toBeNull();
    expect(model.streaming).toBeNull();
    expect(model.pricing).toEqual({ input: null, output: null });
  });

  it('reads a context window when the provider states one', () => {
    expect(normalizeModel(groq, { id: 'a', context_length: 131072 })?.contextLength).toBe(131072);
    expect(normalizeModel(groq, { id: 'b', context_window: 8192 })?.contextLength).toBe(8192);
  });

  /**
   * Unknown is not "no". Most providers report no capabilities at all, and
   * answering false for them would hide models that do call tools.
   */
  it('claims tool calling only when the provider listed it', () => {
    expect(normalizeModel(openrouter, { id: 'a', supported_parameters: ['tools'] })?.toolCalling).toBe(
      true,
    );
    expect(normalizeModel(openrouter, { id: 'b', supported_parameters: ['temperature'] })?.toolCalling).toBe(
      false,
    );
    expect(normalizeModel(openrouter, { id: 'c' })?.toolCalling).toBeNull();
  });

  it('treats a model as available unless the provider said otherwise', () => {
    expect(normalizeModel(groq, { id: 'a' })?.available).toBe(true);
    expect(normalizeModel(groq, { id: 'b', active: false })?.available).toBe(false);
  });

  it('carries no credential-shaped metadata', () => {
    const model = normalizeModel(groq, {
      id: 'a',
      description: 'fine',
      api_key: 'sk-should-never-appear',
      authorization: 'Bearer nope',
    })!;

    expect(JSON.stringify(model)).not.toContain('sk-should-never-appear');
    expect(JSON.stringify(model)).not.toContain('Bearer nope');
    expect(model.providerMetadata.description).toBe('fine');
  });
});

describe('what a model costs', () => {
  /** Read from the provider's own prices, for the provider that quotes them. */
  it('is free only when a quoted price is zero', () => {
    expect(classifyCost(openrouter, { input: 0, output: 0 })).toBe('free');
    expect(classifyCost(openrouter, { input: 0.0000005, output: 0.0000015 })).toBe('paid');
  });

  it('accepts a price quoted as a decimal string, including "0"', () => {
    const free = normalizeModel(openrouter, {
      id: 'x',
      pricing: { prompt: '0', completion: '0' },
    })!;
    const paid = normalizeModel(openrouter, {
      id: 'y',
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
    })!;

    expect(free.cost).toBe('free');
    expect(paid.cost).toBe('paid');
    expect(paid.pricing.input).toBeCloseTo(0.0000002);
  });

  /** A charged completion makes it paid, whatever the prompt costs. */
  it('is paid when only one side is free', () => {
    expect(classifyCost(openrouter, { input: 0, output: 0.000001 })).toBe('paid');
  });

  it('is unknown when a price-quoting provider quoted nothing', () => {
    expect(classifyCost(openrouter, { input: null, output: null })).toBe('unknown');
  });

  /**
   * The distinction the product turns on. An allowance belongs to an account
   * and can run out; calling that "free" would be a promise this software
   * cannot keep.
   */
  it('is free-tier, never free, where the allowance is an account matter', () => {
    expect(classifyCost(groq, { input: null, output: null })).toBe('free-tier');
    expect(normalizeModel(groq, { id: 'a' })?.cost).toBe('free-tier');
  });

  it('is paid for a provider that states it has no free tier', () => {
    expect(classifyCost(anthropic, { input: null, output: null })).toBe('paid');
  });

  /** Never from the name. A provider renaming a model must not change this. */
  it('is not inferred from the model name', () => {
    const named = normalizeModel(openrouter, {
      id: 'vendor/model-free',
      pricing: { prompt: '0.000003', completion: '0.000009' },
    })!;

    expect(named.cost).toBe('paid');
  });
});

describe('normalising a list', () => {
  it('reads the OpenAI-shaped envelope', () => {
    const models = normalizeModelList(groq, { data: [{ id: 'a' }, { id: 'b' }] });

    expect(models.map((model) => model.modelId)).toEqual(['a', 'b']);
  });

  it('accepts a bare array, which some gateways return', () => {
    expect(normalizeModelList(groq, [{ id: 'a' }])).toHaveLength(1);
  });

  it('deduplicates by id, keeping the provider’s order', () => {
    const models = normalizeModelList(groq, { data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });

    expect(models.map((model) => model.modelId)).toEqual(['b', 'a']);
  });

  it('skips unusable entries instead of failing the whole list', () => {
    const models = normalizeModelList(groq, { data: [{ id: 'good' }, {}, null, { id: '' }] });

    expect(models.map((model) => model.modelId)).toEqual(['good']);
  });

  it('refuses a shape it cannot read rather than guessing', () => {
    expect(() => normalizeModelList(groq, { models: 'nope' })).toThrow(ProviderError);
    expect(() => normalizeModelList(groq, 'nope')).toThrow(/could not read/i);
  });

  it('caps a response too large to be a model list', () => {
    const data = Array.from({ length: MAX_DISCOVERED_MODELS + 50 }, (_, index) => ({
      id: `model-${index}`,
    }));

    expect(normalizeModelList(groq, { data })).toHaveLength(MAX_DISCOVERED_MODELS);
  });

  /** The acceptance criterion: as many as the provider actually offers. */
  it('represents as many models as the provider returns', () => {
    const data = Array.from({ length: 24 }, (_, index) => ({
      id: `vendor/model-${index}`,
      context_length: 8192,
      supported_parameters: ['tools', 'stream'],
      pricing: { prompt: index % 2 === 0 ? '0' : '0.000001', completion: index % 2 === 0 ? '0' : '0.000002' },
    }));

    const models = normalizeModelList(openrouter, { data });

    expect(models).toHaveLength(24);
    expect(models.filter((model) => model.cost === 'free')).toHaveLength(12);
    expect(models.filter((model) => model.cost === 'paid')).toHaveLength(12);
    expect(models.every((model) => model.toolCalling === true)).toBe(true);
  });
});

describe('asking the provider', () => {
  it('sends the key in a header and never in the URL', async () => {
    const fetchImpl = answering({ data: [{ id: 'a' }] });

    await discoverModels({ provider: groq, apiKey: 'gsk-secret', fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${groq.baseUrl}/models`);
    expect(url).not.toContain('gsk-secret');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gsk-secret');
  });

  it('returns what the provider returned, with a fetch time', async () => {
    const result = await discoverModels({
      provider: groq,
      apiKey: 'k',
      fetchImpl: answering({ data: [{ id: 'a' }, { id: 'b' }] }),
    });

    expect(result.providerId).toBe('groq');
    expect(result.models).toHaveLength(2);
    expect(result.fetchedAt).toBeGreaterThan(0);
  });

  it('refuses to ask a provider that publishes no list', async () => {
    await expect(discoverModels({ provider: anthropic, apiKey: 'k' })).rejects.toThrow(
      /does not publish a model list/i,
    );
  });

  it('asks for a base URL before asking for models', async () => {
    await expect(discoverModels({ provider: generic, fetchImpl: answering({}) })).rejects.toThrow(
      /needs a base URL/i,
    );
  });

  it('asks for a key when the provider requires one', async () => {
    await expect(discoverModels({ provider: groq, fetchImpl: answering({}) })).rejects.toThrow(
      /needs an API key/i,
    );
  });

  it('reports a refused key as unauthorized, without echoing it', async () => {
    const fetchImpl = answering({}, { status: 401 });

    const failure = await discoverModels({ provider: groq, apiKey: 'gsk-secret', fetchImpl }).catch(
      (error: ProviderError) => error,
    );

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe('unauthorized');
    expect((failure as ProviderError).message).not.toContain('gsk-secret');
  });

  it('reports a rate limit and the retry time the provider gave', async () => {
    const fetchImpl = answering({}, {
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
    });

    const failure = (await discoverModels({ provider: groq, apiKey: 'k', fetchImpl }).catch(
      (error) => error,
    )) as ProviderError;

    expect(failure.kind).toBe('rate-limited');
    expect(failure.retryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('treats a missing /models as a provider to type into, not a failure to hide', async () => {
    const failure = (await discoverModels({
      provider: generic,
      baseUrl: 'https://gateway.test/v1',
      fetchImpl: answering({}, { status: 404 }),
    }).catch((error) => error)) as ProviderError;

    expect(failure.kind).toBe('not-configured');
    expect(failure.message).toMatch(/by hand/i);
  });

  it('reports a server failure as the provider’s, not the user’s', async () => {
    const failure = (await discoverModels({
      provider: groq,
      apiKey: 'k',
      fetchImpl: answering({}, { status: 503 }),
    }).catch((error) => error)) as ProviderError;

    expect(failure.kind).toBe('server');
  });

  it('reports an unreachable host as a network failure', async () => {
    const failure = (await discoverModels({
      provider: groq,
      apiKey: 'k',
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    }).catch((error) => error)) as ProviderError;

    expect(failure.kind).toBe('network');
    expect(failure.message).toMatch(/api\.groq\.com/);
  });

  it('reports a non-JSON answer as malformed', async () => {
    const failure = (await discoverModels({
      provider: groq,
      apiKey: 'k',
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            throw new SyntaxError('not json');
          },
        }) as unknown as Response,
      ),
    }).catch((error) => error)) as ProviderError;

    expect(failure.kind).toBe('malformed');
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    const failure = (await discoverModels({
      provider: groq,
      apiKey: 'k',
      signal: controller.signal,
      fetchImpl: vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    }).catch((error) => error)) as ProviderError;

    expect(failure.message).toMatch(/cancelled/i);
  });
});

describe('reusing an answer', () => {
  it('asks once and reuses the list', async () => {
    const fetchImpl = answering({ data: [{ id: 'a' }] });

    await discoverModelsCached({ provider: groq, apiKey: 'k', fetchImpl });
    await discoverModelsCached({ provider: groq, apiKey: 'k', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks again when refresh is requested', async () => {
    const fetchImpl = answering({ data: [{ id: 'a' }] });

    await discoverModelsCached({ provider: groq, apiKey: 'k', fetchImpl });
    await discoverModelsCached({ provider: groq, apiKey: 'k', fetchImpl, refresh: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /** A different server is a different list, not the previous server's answer. */
  it('keys the held list on the endpoint as well as the provider', async () => {
    const fetchImpl = answering({ data: [{ id: 'a' }] });

    await discoverModelsCached({
      provider: generic,
      baseUrl: 'https://one.test/v1',
      fetchImpl,
    });
    await discoverModelsCached({
      provider: generic,
      baseUrl: 'https://two.test/v1',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('filtering, which is what the picker does', () => {
  const models: ModelRecord[] = [
    {
      providerId: 'openrouter',
      modelId: 'vendor/free-tools',
      displayName: 'Free With Tools',
      contextLength: 32768,
      toolCalling: true,
      streaming: true,
      pricing: { input: 0, output: 0 },
      cost: 'free',
      available: true,
      providerMetadata: {},
    },
    {
      providerId: 'openrouter',
      modelId: 'vendor/paid-notools',
      displayName: 'Paid No Tools',
      contextLength: 8192,
      toolCalling: false,
      streaming: true,
      pricing: { input: 0.000001, output: 0.000002 },
      cost: 'paid',
      available: true,
      providerMetadata: {},
    },
    {
      providerId: 'groq',
      modelId: 'other/unknown-caps',
      displayName: 'Unknown Capabilities',
      contextLength: null,
      toolCalling: null,
      streaming: null,
      pricing: { input: null, output: null },
      cost: 'free-tier',
      available: false,
      providerMetadata: {},
    },
  ];

  it('searches the id and the display name', () => {
    expect(filterModels(models, { query: 'free-tools' })).toHaveLength(1);
    expect(filterModels(models, { query: 'unknown capabilities' })).toHaveLength(1);
    expect(filterModels(models, { query: 'nothing here' })).toHaveLength(0);
  });

  it('filters by provider', () => {
    expect(filterModels(models, { providerId: 'groq' })).toHaveLength(1);
  });

  it('filters by cost, keeping free and free-tier distinct', () => {
    expect(filterModels(models, { cost: ['free'] }).map((m) => m.modelId)).toEqual([
      'vendor/free-tools',
    ]);
    expect(filterModels(models, { cost: ['free-tier'] }).map((m) => m.modelId)).toEqual([
      'other/unknown-caps',
    ]);
    expect(filterModels(models, { cost: ['free', 'free-tier'] })).toHaveLength(2);
  });

  it('filters out only models the provider said cannot call tools', () => {
    const kept = filterModels(models, { toolCallingOnly: true }).map((model) => model.modelId);

    expect(kept).toContain('vendor/free-tools');
    // Unknown is kept: the provider never said, and hiding it would hide
    // working models for every provider that reports no capabilities.
    expect(kept).toContain('other/unknown-caps');
    expect(kept).not.toContain('vendor/paid-notools');
  });

  it('filters by what the provider reported as available', () => {
    expect(filterModels(models, { availableOnly: true })).toHaveLength(2);
  });

  it('combines filters', () => {
    const kept = filterModels(models, {
      providerId: 'openrouter',
      cost: ['free'],
      toolCallingOnly: true,
      availableOnly: true,
    });

    expect(kept.map((model) => model.modelId)).toEqual(['vendor/free-tools']);
  });
});
