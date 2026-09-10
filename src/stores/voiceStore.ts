import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  LISTEN_ERROR_MESSAGE,
  listenOnce,
  speak,
  speechToTextAvailable,
  stopSpeaking,
  textToSpeechAvailable,
  type ListenErrorKind,
  type ListenHandle,
} from '@/lib/voice/speech';

/**
 * Talking to the agent, as another way in rather than another agent.
 *
 * Speech is turned into text and handed to `aiStore.send` — the same function
 * the text box calls. That is the whole design: the same tools, the same
 * approval prompts, the same permission checks, the same audit trail. A
 * separate "voice assistant" with its own shortcut path would be a second
 * agent with a second set of rules, and the rules are the security model.
 *
 * **The microphone opens only when a person opens it.** `startListening` runs
 * from a press. There is no wake word, no listening on mount, and no listening
 * between turns: recognition is per-utterance and the engine closes the stream
 * when the utterance ends. `state` is what the UI shows, and it is never
 * `listening` unless the microphone really is open.
 *
 * **Speech is interruptible.** `stopSpeaking` cancels mid-sentence, and
 * pressing to talk while the agent is speaking silences it first — being talked
 * over by software you cannot stop is the fastest way to make a voice mode
 * unusable.
 */

export type VoiceState =
  /** Nothing happening. The microphone is closed. */
  | 'idle'
  /** The microphone is open and a person is speaking. */
  | 'listening'
  /** The agent is working on what was said. */
  | 'thinking'
  /** The agent is reading its answer aloud. */
  | 'speaking';

interface VoiceStore {
  state: VoiceState;
  /** The engine's running guess while listening. Never acted on. */
  interim: string;
  /** The last utterance that was actually sent. */
  lastHeard: string;
  /** A failure worth showing, in words a person can act on. */
  error: string | null;
  /** Whether answers are read aloud. Off does not disable listening. */
  replyAloud: boolean;

  available: () => { listen: boolean; speak: boolean };
  setReplyAloud: (on: boolean) => void;
  startListening: (send: (prompt: string) => Promise<void>) => void;
  /** Finish the utterance and let it be sent. */
  stopListening: () => void;
  /** Abandon the utterance. Nothing is sent. */
  cancelListening: () => void;
  /** Silence the agent mid-sentence. */
  silence: () => void;
  /** Read an answer aloud, if the person asked for that. */
  announce: (text: string) => void;
  dismissError: () => void;
}

/**
 * The live recognition handle.
 *
 * Module-level rather than in the store because it is not state anyone renders
 * — and because putting a live platform object in a store invites it being
 * cloned, persisted or compared.
 */
let handle: ListenHandle | null = null;

export const useVoiceStore = create<VoiceStore>()(
  persist(
    (set, get) => ({
      state: 'idle',
      interim: '',
      lastHeard: '',
      error: null,
      replyAloud: true,

      available: () => ({
        listen: speechToTextAvailable(),
        speak: textToSpeechAvailable(),
      }),

      setReplyAloud: (on) => {
        if (!on) stopSpeaking();
        set((current) => ({
          replyAloud: on,
          state: !on && current.state === 'speaking' ? 'idle' : current.state,
        }));
      },

      startListening(send) {
        if (get().state === 'listening') return;
        // Being talked over is the fastest way to make this unusable.
        stopSpeaking();
        set({ error: null, interim: '' });

        const started = listenOnce({
          onStart: () => set({ state: 'listening' }),
          onInterim: (text) => set({ interim: text }),
          onFinal: (text) => {
            set({ state: 'thinking', interim: '', lastHeard: text });
            /*
             * The same door the text box uses.
             *
             * Everything that governs a typed request — tool permissions,
             * approval prompts for destructive actions, the audit trail —
             * governs this one, because it is the same request.
             */
            void send(text)
              .catch((error: unknown) =>
                set({ error: error instanceof Error ? error.message : 'The request failed.' }),
              )
              .finally(() => {
                // `announce` moves this to `speaking` when there is something
                // to read; if it does not, the turn is simply over.
                set((current) => (current.state === 'thinking' ? { state: 'idle' } : current));
              });
          },
          onError: (kind: ListenErrorKind) => {
            set({ error: LISTEN_ERROR_MESSAGE[kind], interim: '' });
          },
          onEnd: () => {
            handle = null;
            // Only back to idle if nothing took over: a final result has
            // already moved this to `thinking`, and clobbering that would show
            // an idle microphone while a request is in flight.
            set((current) => (current.state === 'listening' ? { state: 'idle' } : current));
          },
        });

        if (!started) {
          set({
            state: 'idle',
            error: speechToTextAvailable()
              ? 'Listening could not start.'
              : 'This browser has no speech recognition. Type your request instead.',
          });
          return;
        }
        handle = started;
      },

      stopListening() {
        handle?.stop();
      },

      cancelListening() {
        handle?.abort();
        handle = null;
        set({ state: 'idle', interim: '' });
      },

      silence() {
        stopSpeaking();
        set((current) => (current.state === 'speaking' ? { state: 'idle' } : current));
      },

      announce(text) {
        if (!get().replyAloud || !text.trim()) {
          set((current) => (current.state === 'thinking' ? { state: 'idle' } : current));
          return;
        }
        /*
         * `speaking` is set *before* the engine is handed the text.
         *
         * A short utterance can finish synchronously — some engines do, and the
         * test double does — and setting the state afterwards then overwrote
         * the `idle` that `onEnd` had already written, leaving the UI showing a
         * stop button for speech that had finished.
         */
        set({ state: 'speaking' });
        const speaking = speak(text, {
          onEnd: () => set((current) => (current.state === 'speaking' ? { state: 'idle' } : current)),
          onError: () => set({ state: 'idle' }),
        });
        // Nothing was queued — no engine, or nothing sayable in the answer.
        if (!speaking) set((current) => (current.state === 'speaking' ? { state: 'idle' } : current));
      },

      dismissError: () => set({ error: null }),
    }),
    {
      name: 'ta-code-voice',
      // Only the preference survives a reload. A persisted `listening` would
      // show an open microphone on a page that has not asked for one.
      partialize: (state) => ({ replyAloud: state.replyAloud }),
    },
  ),
);
