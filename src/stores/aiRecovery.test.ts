// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '@/stores/aiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useFileStore } from '@/stores/fileStore';

/**
 * What happens after a turn goes wrong.
 *
 * A failed task used to end as a line of red text with no way forward: the
 * user could not tell a rate limit from a bad key, and retrying meant retyping
 * the prompt. These cover the recovery path — the classification the panel
 * reads, and the retry that reuses the prompt without duplicating the ask.
 */

function reset() {
  useAgentStore.getState().finish('cancelled');
  useAgentStore.setState({ task: null, history: [], pending: null, lockedProjectId: null });
  useAiStore.setState({
    messages: [],
    transcript: [],
    running: false,
    error: null,
    errorKind: null,
    retryAt: null,
    lastPrompt: null,
    provider: { kind: 'openai', model: 'm', baseUrl: 'http://provider.test/v1' },
  });
}

beforeEach(() => {
  reset();
  vi.unstubAllGlobals();
});

/**
 * Answer every provider call with a real HTTP response, so the classification
 * under test is the one the transport actually produces.
 */
function respond(status: number, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status, headers })),
  );
}

/** A completion the agent accepts, so the turn reaches the save step. */
function succeed() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), {
          status: 200,
        }),
    ),
  );
}

describe('a failed turn', () => {
  it('records which kind of failure it was, and when it may be retried', async () => {
    respond(429, { 'retry-after': '30' });
    await useAiStore.getState().send('add a test');

    expect(useAiStore.getState().errorKind).toBe('rate-limited');
    expect(useAiStore.getState().retryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(useAiStore.getState().lastPrompt).toBe('add a test');
    expect(useAiStore.getState().running).toBe(false);
  });

  it('tells a rejected key apart from an outage', async () => {
    respond(401);
    await useAiStore.getState().send('one');
    expect(useAiStore.getState().errorKind).toBe('unauthorized');

    reset();
    respond(503);
    await useAiStore.getState().send('two');
    expect(useAiStore.getState().errorKind).toBe('server');
  });

  /**
   * A failure that is not the provider's — here, saving the work afterwards —
   * must not be dressed up as a provider verdict.
   */
  it('claims no classification it was not given', async () => {
    succeed();
    const flush = useFileStore.getState().flush;
    useFileStore.setState({
      flush: async () => {
        throw new Error('storage is full');
      },
    });
    try {
      await useAiStore.getState().send('three');
    } finally {
      useFileStore.setState({ flush });
    }

    expect(useAiStore.getState().error).toContain('storage is full');
    expect(useAiStore.getState().errorKind).toBeNull();
  });

  it('releases the task lock so the next turn can start', async () => {
    respond(503);
    await useAiStore.getState().send('four');
    expect(useAiStore.getState().running).toBe(false);
    // A second send is accepted rather than refused as "already running".
    await useAiStore.getState().send('five');
    expect(useAiStore.getState().error).not.toMatch(/already running/);
  });
});

describe('retrying', () => {
  it('resends the same prompt without leaving the failed exchange behind', async () => {
    respond(503);
    await useAiStore.getState().send('add a test');
    expect(useAiStore.getState().messages).toHaveLength(2);

    await useAiStore.getState().retry();
    // Still one user turn and one assistant turn, not two of each.
    expect(useAiStore.getState().messages).toHaveLength(2);
    expect(useAiStore.getState().messages[0].text).toBe('add a test');
  });

  it('does nothing when there is no prompt to resend', async () => {
    await useAiStore.getState().retry();
    expect(useAiStore.getState().messages).toEqual([]);
  });

  it('forgets the prompt when the conversation is cleared', async () => {
    respond(503);
    await useAiStore.getState().send('add a test');
    useAiStore.getState().reset();

    expect(useAiStore.getState().lastPrompt).toBeNull();
    expect(useAiStore.getState().errorKind).toBeNull();
    await useAiStore.getState().retry();
    expect(useAiStore.getState().messages).toEqual([]);
  });
});
