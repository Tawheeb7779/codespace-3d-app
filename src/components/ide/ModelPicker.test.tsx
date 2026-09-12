import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from '@/components/ide/ModelPicker';
import { providerById } from '@/lib/ai/providers';
import { clearDiscoveryCache } from '@/lib/ai/modelDiscovery';

/**
 * The picker shows what the provider said, and says so when it cannot ask.
 *
 * What it must never do is present a model the provider did not return, or
 * fill in a field the provider left out. An unconfigured provider is not an
 * empty catalogue, and a failed request is not an account with no models —
 * each of those is a different sentence, and the user needs the right one.
 */

const groq = providerById('groq')!;
const openrouter = providerById('openrouter')!;
const anthropic = providerById('anthropic')!;
const generic = providerById('openai')!;

const answering = (payload: unknown, status = 200) =>
  vi.fn(async () =>
    ({
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => payload,
    }) as unknown as Response,
  );

beforeEach(() => {
  clearDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('when the provider cannot be asked', () => {
  /** Its list is a different request, so it keeps the field that works. */
  it('keeps a text field for a provider that publishes no list', () => {
    render(
      <ModelPicker provider={anthropic} apiKey="k" selected="some-model" onSelect={() => {}} />,
    );

    expect(screen.getByLabelText('Model')).toHaveValue('some-model');
    expect(screen.getByText(/does not publish a model list/i)).toBeTruthy();
  });

  it('asks for a key before claiming to know the models', () => {
    render(<ModelPicker provider={groq} selected="" onSelect={() => {}} />);

    expect(screen.getByText(/Add a key to see the models/i)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('asks for a base URL when the endpoint is the user’s own', () => {
    render(<ModelPicker provider={generic} baseUrl="" selected="" onSelect={() => {}} />);

    expect(screen.getByText(/Set a base URL to see the models/i)).toBeTruthy();
  });
});

describe('when the provider answers', () => {
  it('lists exactly the models it returned', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'vendor/one' }, { id: 'vendor/two' }] }));

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('vendor/one')).toBeTruthy());
    expect(screen.getByText('vendor/two')).toBeTruthy();
    expect(screen.getByText(/2 models from Groq/i)).toBeTruthy();
  });

  it('shows a context window only when the provider stated one', async () => {
    vi.stubGlobal(
      'fetch',
      answering({ data: [{ id: 'with-context', context_length: 32768 }, { id: 'without' }] }),
    );

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('with-context')).toBeTruthy());
    expect(screen.getByText('32K context')).toBeTruthy();
    // The other model gets no invented number: exactly one row shows a window.
    expect(screen.getAllByText(/^\d+K? context$/)).toHaveLength(1);
  });

  it('says tool support is unstated rather than guessing', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'quiet' }] }));

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Tool support not stated/i)).toBeTruthy());
  });

  /** Free and free tier are different promises and must not read alike. */
  it('labels a zero-priced model free and an allowance free tier', async () => {
    vi.stubGlobal(
      'fetch',
      answering({ data: [{ id: 'zero', pricing: { prompt: '0', completion: '0' } }] }),
    );

    const { unmount } = render(
      <ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Free')).toBeTruthy());
    unmount();
    clearDiscoveryCache();

    vi.stubGlobal('fetch', answering({ data: [{ id: 'allowance' }] }));
    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('Free tier')).toBeTruthy());
  });

  it('reports a model the provider marked unavailable', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'retired', active: false }] }));

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
  });

  it('selects a model by its exact id', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'vendor/exact-id' }] }));
    const onSelect = vi.fn();

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('vendor/exact-id')).toBeTruthy());
    await userEvent.click(screen.getByText('vendor/exact-id'));

    expect(onSelect).toHaveBeenCalledWith('vendor/exact-id');
  });

  it('marks the configured model as current', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'a' }, { id: 'b' }] }));

    render(<ModelPicker provider={groq} apiKey="k" selected="b" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('b')).toBeTruthy());
    const current = screen.getAllByRole('button').filter((node) => node.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('b');
  });
});

describe('narrowing the list', () => {
  const payload = {
    data: [
      { id: 'vendor/alpha', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      {
        id: 'vendor/beta',
        pricing: { prompt: '0.000002', completion: '0.000004' },
        supported_parameters: ['temperature'],
      },
    ],
  };

  it('searches the models the provider returned', async () => {
    vi.stubGlobal('fetch', answering(payload));

    render(<ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('vendor/alpha')).toBeTruthy());

    await userEvent.type(screen.getByLabelText('Model'), 'beta');

    await waitFor(() => expect(screen.queryByText('vendor/alpha')).toBeNull());
    expect(screen.getByText('vendor/beta')).toBeTruthy();
  });

  it('filters by cost', async () => {
    vi.stubGlobal('fetch', answering(payload));

    render(<ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('vendor/beta')).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText('Cost'), 'free');

    expect(screen.getByText('vendor/alpha')).toBeTruthy();
    expect(screen.queryByText('vendor/beta')).toBeNull();
  });

  it('hides only the models the provider said cannot call tools', async () => {
    vi.stubGlobal('fetch', answering(payload));

    render(<ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('vendor/beta')).toBeTruthy());

    await userEvent.click(screen.getByLabelText(/cannot call tools/i));

    expect(screen.getByText('vendor/alpha')).toBeTruthy();
    expect(screen.queryByText('vendor/beta')).toBeNull();
  });

  it('says the filters matched nothing, and how many there were', async () => {
    vi.stubGlobal('fetch', answering(payload));

    render(<ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('vendor/alpha')).toBeTruthy());

    await userEvent.type(screen.getByLabelText('Model'), 'nothing-matches-this');

    await waitFor(() => expect(screen.getByText(/No model matches those filters/i)).toBeTruthy());
    expect(screen.getByText(/offered 2 models/i)).toBeTruthy();
  });
});

describe('when the provider refuses', () => {
  it('reports a refused key without echoing it', async () => {
    vi.stubGlobal('fetch', answering({}, 401));

    render(<ModelPicker provider={groq} apiKey="gsk-secret" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Could not list models/i)).toBeTruthy());
    expect(screen.getByText(/refused the API key/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('gsk-secret');
  });

  it('offers to ask again rather than leaving a dead panel', async () => {
    const fetchImpl = answering({}, 503);
    vi.stubGlobal('fetch', fetchImpl);

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Could not list models/i)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Try again/i }));

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThan(1));
  });

  /** An empty answer is the account's, not a failure to describe as one. */
  it('distinguishes an empty list from a failed request', async () => {
    vi.stubGlobal('fetch', answering({ data: [] }));

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText(/returned no models/i)).toBeTruthy());
    expect(screen.queryByText(/Could not list models/i)).toBeNull();
  });
});

describe('refreshing', () => {
  it('asks the provider again on request', async () => {
    const fetchImpl = answering({ data: [{ id: 'a' }] });
    vi.stubGlobal('fetch', fetchImpl);

    render(<ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Ask the provider again/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });
});

describe('switching provider', () => {
  it('asks the new provider rather than showing the old one’s models', async () => {
    vi.stubGlobal('fetch', answering({ data: [{ id: 'groq-only' }] }));
    const { unmount } = render(
      <ModelPicker provider={groq} apiKey="k" selected="" onSelect={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('groq-only')).toBeTruthy());
    unmount();

    vi.stubGlobal('fetch', answering({ data: [{ id: 'router-only' }] }));
    render(<ModelPicker provider={openrouter} apiKey="k" selected="" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText('router-only')).toBeTruthy());
    expect(screen.queryByText('groq-only')).toBeNull();
  });
});
