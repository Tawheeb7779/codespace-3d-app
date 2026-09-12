import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * What the panel says while an answer is being written, and after.
 *
 * The distinction being checked is between "nothing has come back yet" and
 * "the answer is arriving": a spinner over a growing paragraph has to read as
 * generation in progress, and it has to disappear when the turn ends —
 * an indicator left under a finished answer says the answer never finished.
 *
 * The token line is checked for the same reason. A turn is several model calls
 * and providers are inconsistent about reporting usage, so a sum over some of
 * them is a floor and must be labelled as one.
 */

vi.mock('@/lib/ai/hosted', () => ({
  hostedAiAvailable: () => false,
  hostedResolverFor: () => null,
  aiTransport: () => 'byok',
  hostedGeminiEndpoint: async () => null,
}));

import { AssistantPanel } from '@/components/ide/AssistantPanel';
import { useAiStore } from '@/stores/aiStore';
import type { AssistantMessage } from '@/stores/aiStore';
import { DEFAULT_PROVIDER } from '@/lib/ai/provider';
import type { UsageTally } from '@/lib/ai/agent';

const message = (patch: Partial<AssistantMessage>): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  text: '',
  activities: [],
  timestamp: 0,
  ...patch,
});

function panel(state: {
  messages: AssistantMessage[];
  running: boolean;
  usage?: UsageTally | null;
}) {
  useAiStore.setState({
    provider: { ...DEFAULT_PROVIDER, kind: 'openai', baseUrl: 'http://x/v1' },
    apiKeyPresent: true,
    messages: state.messages,
    running: state.running,
    usage: state.usage ?? null,
    error: null,
    errorKind: null,
  });
  render(<AssistantPanel />);
}

beforeEach(() => {
  useAiStore.setState({ messages: [], running: false, usage: null });
});

describe('while the answer is arriving', () => {
  it('shows the text that has arrived so far', () => {
    panel({ messages: [message({ text: 'Looking at the' })], running: true });

    expect(screen.getByText('Looking at the')).toBeTruthy();
  });

  it('says it is generating once text has started', () => {
    panel({ messages: [message({ text: 'Looking at the' })], running: true });

    expect(screen.getByText('Generating…')).toBeTruthy();
    expect(screen.queryByText('Working…')).toBeNull();
  });

  it('says it is working before anything has come back', () => {
    panel({ messages: [message({ text: '' })], running: true });

    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.queryByText('Generating…')).toBeNull();
  });

  /** A real Stop, which the store wires to the request's abort controller. */
  it('offers to stop rather than to send', () => {
    panel({ messages: [message({ text: 'half' })], running: true });

    expect(screen.getByLabelText('Stop the assistant')).toBeTruthy();
    expect(screen.queryByLabelText('Send message')).toBeNull();
  });
});

describe('once the turn has ended', () => {
  it('drops the indicator and keeps the answer', () => {
    panel({ messages: [message({ text: 'The answer.' })], running: false });

    expect(screen.getByText('The answer.')).toBeTruthy();
    expect(screen.queryByText('Generating…')).toBeNull();
    expect(screen.queryByText('Working…')).toBeNull();
  });

  /** Cancelled mid-answer: what arrived is real and stays. */
  it('keeps the part of a cancelled answer that did arrive', () => {
    panel({ messages: [message({ text: 'I was saying' })], running: false });

    expect(screen.getByText('I was saying')).toBeTruthy();
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  it('recovers ready to send the next message', () => {
    panel({ messages: [message({ text: 'done' })], running: false });

    expect((screen.getByLabelText('Message the assistant') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
  });

  it('leaves the indicator off older messages while a new turn runs', () => {
    panel({
      messages: [
        message({ id: 'old', text: 'first answer' }),
        message({ id: 'new', text: 'second' }),
      ],
      running: true,
    });

    // One indicator, on the message actually being written.
    expect(screen.getAllByText('Generating…')).toHaveLength(1);
  });
});

describe('what the turn cost', () => {
  it('reports the tokens the provider said it used', () => {
    panel({
      messages: [message({ text: 'done' })],
      running: false,
      usage: { inputTokens: 1234, outputTokens: 56, reported: 2, steps: 2 },
    });

    expect(screen.getByText('1,234 in · 56 out')).toBeTruthy();
  });

  /** A sum over three of five steps is a floor, and says so. */
  it('marks a partially reported tally as a floor', () => {
    panel({
      messages: [message({ text: 'done' })],
      running: false,
      usage: { inputTokens: 100, outputTokens: 10, reported: 1, steps: 3 },
    });

    expect(screen.getByText('at least 100 in · 10 out')).toBeTruthy();
  });

  it('shows nothing at all when no provider reported any usage', () => {
    panel({
      messages: [message({ text: 'done' })],
      running: false,
      usage: { inputTokens: 0, outputTokens: 0, reported: 0, steps: 1 },
    });

    expect(screen.queryByText(/ in · /)).toBeNull();
  });
});
