import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkForSpeech, spokenForm } from '@/lib/voice/speech';

/**
 * Voice as another way into the same agent, and the safety that has to hold.
 *
 * Three properties matter more than any feature here.
 *
 * The microphone is never open unless a person opened it. There is no wake
 * word, nothing starts on mount, and recognition is per-utterance — so the
 * store must never reach `listening` on its own, and must return to `idle`
 * when an utterance ends.
 *
 * A spoken request is the *same* request as a typed one. It goes through
 * `aiStore.send`, so tool permissions and approval prompts apply unchanged. A
 * voice path that reached tools directly would be a second agent with a second
 * set of rules, and the rules are the security model.
 *
 * And what is on screen is what is happening. `listening` appears only once the
 * engine has really started; a failure is reported rather than swallowed.
 */

interface FakeRecognition {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  started: boolean;
  aborted: boolean;
  stopped: boolean;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

let engine: FakeRecognition;
let spoken: string[];
let cancelled: number;

/** A result the engine would deliver. */
const result = (transcript: string, isFinal: boolean) => ({
  resultIndex: 0,
  results: Object.assign([Object.assign([{ transcript }], { isFinal })], { length: 1 }),
});

beforeEach(async () => {
  spoken = [];
  cancelled = 0;

  class Recognition {
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    lang = '';
    started = false;
    aborted = false;
    stopped = false;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    constructor() {
      engine = this as unknown as FakeRecognition;
    }
    start() {
      this.started = true;
      this.onstart?.();
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.aborted = true;
    }
  }

  vi.stubGlobal('SpeechRecognition', Recognition);
  vi.stubGlobal('speechSynthesis', {
    speak: (utterance: { text: string; onend?: () => void }) => {
      spoken.push(utterance.text);
      utterance.onend?.();
    },
    cancel: () => {
      cancelled += 1;
    },
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string;
      lang = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  );

  const { useVoiceStore } = await import('@/stores/voiceStore');
  useVoiceStore.setState({ state: 'idle', interim: '', lastHeard: '', error: null, replyAloud: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const store = async () => (await import('@/stores/voiceStore')).useVoiceStore;

describe('the microphone', () => {
  it('is closed until a person opens it', async () => {
    const useVoiceStore = await store();

    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('opens only on an explicit start, and says so only once the engine has started', async () => {
    const useVoiceStore = await store();
    const send = vi.fn(async () => undefined);

    useVoiceStore.getState().startListening(send);

    expect(engine.started).toBe(true);
    expect(useVoiceStore.getState().state).toBe('listening');
  });

  /** A continuous stream would stay open between turns. It must not. */
  it('listens for one utterance rather than continuously', async () => {
    const useVoiceStore = await store();

    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    expect(engine.continuous).toBe(false);
  });

  it('closes and returns to idle when the utterance ends with nothing said', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    engine.onend!();

    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('sends nothing when the utterance is abandoned', async () => {
    const useVoiceStore = await store();
    const send = vi.fn(async () => undefined);
    useVoiceStore.getState().startListening(send);

    useVoiceStore.getState().cancelListening();

    expect(engine.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('does not start a second engine while already listening', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().startListening(vi.fn(async () => undefined));
    const first = engine;

    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    expect(engine).toBe(first);
  });
});

describe('what a spoken request does', () => {
  /** The whole security argument: one door, one set of rules. */
  it('goes through the same send the text box uses', async () => {
    const useVoiceStore = await store();
    const send = vi.fn(async () => undefined);
    useVoiceStore.getState().startListening(send);

    engine.onresult!(result('run the tests', true));

    expect(send).toHaveBeenCalledWith('run the tests');
  });

  it('never acts on the engine’s running guess', async () => {
    const useVoiceStore = await store();
    const send = vi.fn(async () => undefined);
    useVoiceStore.getState().startListening(send);

    engine.onresult!(result('run the te', false));

    expect(send).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().interim).toBe('run the te');
  });

  it('shows it is working while the agent works', async () => {
    const useVoiceStore = await store();
    let release: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    useVoiceStore.getState().startListening(send as never);

    engine.onresult!(result('explain this file', true));
    expect(useVoiceStore.getState().state).toBe('thinking');

    release();
  });

  it('reports a failed request rather than silently returning to idle', async () => {
    const useVoiceStore = await store();
    const send = vi.fn(async () => {
      throw new Error('The provider refused.');
    });
    useVoiceStore.getState().startListening(send);

    engine.onresult!(result('do a thing', true));
    await vi.waitFor(() => expect(useVoiceStore.getState().error).toBeTruthy());

    expect(useVoiceStore.getState().error).toMatch(/provider refused/i);
  });
});

describe('when listening fails', () => {
  it('explains a refused microphone in words a person can act on', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    engine.onerror!({ error: 'not-allowed' });

    expect(useVoiceStore.getState().error).toMatch(/microphone access was refused/i);
  });

  it('says nothing was heard rather than leaving a silent press unexplained', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    engine.onend!();

    expect(useVoiceStore.getState().error).toMatch(/nothing was heard/i);
  });

  /** An abort is this app stopping the engine, not a failure to show someone. */
  it('does not report an abort as an error', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    engine.onerror!({ error: 'aborted' });

    expect(useVoiceStore.getState().error).toBeNull();
  });
});

describe('speaking', () => {
  it('reads a finished answer aloud and returns to idle', async () => {
    const useVoiceStore = await store();

    useVoiceStore.getState().announce('I ran the tests. They pass.');

    expect(spoken.join(' ')).toContain('I ran the tests');
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('says nothing when spoken replies are off', async () => {
    const useVoiceStore = await store();
    useVoiceStore.getState().setReplyAloud(false);

    useVoiceStore.getState().announce('Some answer.');

    expect(spoken).toEqual([]);
  });

  /** Software you cannot interrupt is software people stop using. */
  it('can be silenced mid-sentence', async () => {
    const useVoiceStore = await store();
    useVoiceStore.setState({ state: 'speaking' });

    useVoiceStore.getState().silence();

    expect(cancelled).toBeGreaterThan(0);
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('stops speaking when a person presses to talk', async () => {
    const useVoiceStore = await store();
    useVoiceStore.setState({ state: 'speaking' });
    const before = cancelled;

    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    expect(cancelled).toBeGreaterThan(before);
  });
});

describe('turning an answer into something worth hearing', () => {
  /**
   * Reading a fenced block aloud is unusable. The code stays on screen, where
   * it can be read, and speech summarises that it is there.
   */
  it('does not read code blocks character by character', () => {
    const spokenText = spokenForm('Here it is:\n```ts\nconst x = 1;\n```\nThat is all.');

    expect(spokenText).not.toContain('const x = 1');
    expect(spokenText).toMatch(/code block/i);
    expect(spokenText).toContain('That is all.');
  });

  it('strips markdown a person would otherwise hear as punctuation', () => {
    const spokenText = spokenForm('## Heading\n**bold** and `code` and [a link](https://x.test)');

    expect(spokenText).not.toContain('##');
    expect(spokenText).not.toContain('**');
    expect(spokenText).toContain('bold');
    expect(spokenText).toContain('a link');
    expect(spokenText).not.toContain('https://x.test');
  });

  it('splits a long answer at sentence ends so no engine truncates it', () => {
    const chunks = chunkForSpeech(`${'A sentence here. '.repeat(40)}`, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('still splits a single sentence that is longer than the limit', () => {
    const chunks = chunkForSpeech('x'.repeat(500), 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });
});

describe('a browser with no speech engine', () => {
  it('says so instead of appearing to listen', async () => {
    vi.unstubAllGlobals();
    const useVoiceStore = await store();
    useVoiceStore.setState({ state: 'idle', error: null });

    useVoiceStore.getState().startListening(vi.fn(async () => undefined));

    expect(useVoiceStore.getState().state).toBe('idle');
    expect(useVoiceStore.getState().error).toMatch(/no speech recognition/i);
  });
});
