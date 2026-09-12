import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * What a signed-in user is asked for.
 *
 * The point of hosting the assistant is that the answer is "nothing". That is a
 * claim about absence, so it is checked against the real dialog: choose Gemini
 * on a deployment that provides it, and there must be no key field and no
 * endpoint field to get wrong — while every bring-your-own-key provider keeps
 * both.
 */

/*
 * `vi.hoisted`, because `vi.mock` factories are hoisted above this file's own
 * declarations. The store now resolves the transport when it is created —
 * which is import time — so the mocked module is evaluated before a plain
 * `const` here would exist, and the factory closed over a binding in its
 * temporal dead zone.
 */
const hosted = vi.hoisted(() => ({ available: true }));

vi.mock('@/lib/ai/hosted', () => ({
  hostedAiAvailable: () => hosted.available,
  hostedResolverFor: () => null,
  aiTransport: () => (hosted.available ? 'hosted' : 'byok'),
  hostedGeminiEndpoint: async () => null,
}));

import { ConnectDialog } from '@/components/ide/AssistantPanel';
import { useAiStore } from '@/stores/aiStore';
import { DEFAULT_PROVIDER } from '@/lib/ai/provider';

const open = () => render(<ConnectDialog open onClose={() => undefined} />);
const chooseProvider = (kind: string) =>
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: kind } });

const keyField = () => screen.queryByLabelText('API key');
const baseUrlField = () => screen.queryByLabelText('Base URL');

beforeEach(() => {
  hosted.available = true;
  useAiStore.setState({ provider: { ...DEFAULT_PROVIDER }, apiKeyPresent: false });
});

describe('a deployment that provides the assistant', () => {
  it('asks for no key when Gemini is chosen', () => {
    open();

    chooseProvider('gemini');

    expect(keyField()).toBeNull();
  });

  it('asks for no endpoint either', () => {
    open();

    chooseProvider('gemini');

    expect(baseUrlField()).toBeNull();
  });

  it('says who is providing it, so nobody goes looking for a key', () => {
    open();

    chooseProvider('gemini');

    // The note is a <p> wrapping a <span>, so both match; one is enough.
    expect(screen.getAllByText(/Provided by TA CODE/i).length).toBeGreaterThan(0);
  });

  it('still lets the model be chosen', () => {
    open();

    chooseProvider('gemini');

    const model = screen.getByLabelText('Model') as HTMLInputElement;
    expect(model.value).toMatch(/^gemini-/);
    fireEvent.change(model, { target: { value: 'gemini-2.5-pro' } });
    expect(useAiStore.getState().provider.model).toBe('gemini-2.5-pro');
  });

  /**
   * The regression this guards: hosting Gemini must not quietly take the key
   * field away from the providers that still need one.
   */
  it('keeps bring-your-own-key for Anthropic', () => {
    open();

    chooseProvider('anthropic');

    expect(keyField()).not.toBeNull();
  });

  it('keeps the key and the base URL for an OpenAI-compatible endpoint', () => {
    open();

    chooseProvider('openai');

    expect(keyField()).not.toBeNull();
    expect(baseUrlField()).not.toBeNull();
  });
});

describe('Local Development Mode', () => {
  beforeEach(() => {
    hosted.available = false;
  });

  it('asks for a Gemini key, because there is no server to hold one', () => {
    open();

    chooseProvider('gemini');

    expect(keyField()).not.toBeNull();
    expect(baseUrlField()).not.toBeNull();
  });

  it('says plainly that the key is the developer’s own', () => {
    open();

    chooseProvider('gemini');

    expect(screen.getAllByText(/Local Development Mode has no server/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Provided by TA CODE/i)).toHaveLength(0);
  });
});
