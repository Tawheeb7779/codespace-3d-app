import { useEffect, useRef } from 'react';
import { Mic, Square, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { useVoiceStore } from '@/stores/voiceStore';
import { useAiStore } from '@/stores/aiStore';
import { cx } from '@/lib/utils';

/**
 * Talking to the agent, from the assistant panel.
 *
 * The button is push-to-talk: hold it, speak, release. Holding rather than
 * toggling is the honest shape for a microphone — while the button is down the
 * microphone is open, and when it is not, it is not, with no state anybody has
 * to remember or trust. A keyboard and a screen reader get the same thing
 * through key-down and key-up, and a click that lands without a matching
 * release still ends the utterance rather than leaving the microphone open.
 *
 * What is on screen is what is happening. `listening` appears only when the
 * engine has actually started; `speaking` only while audio is playing, with a
 * stop button beside it, because being talked over by software you cannot
 * interrupt is the fastest way to abandon a voice mode.
 *
 * The request itself goes through `aiStore.send`, exactly as a typed one does.
 * There is no shortcut past approvals here, because there is no second path.
 */
export function VoiceControl() {
  const { state, interim, error, replyAloud, setReplyAloud, startListening, stopListening, silence, dismissError, announce } =
    useVoiceStore();
  const available = useVoiceStore((s) => s.available());
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const messages = useAiStore((s) => s.messages);

  /**
   * Read a reply aloud once it is finished, and only then.
   *
   * Announcing while the answer is still streaming would read a half-written
   * sentence and then repeat it. `running` going false with a settled
   * assistant message is the finished turn, and the id guard stops the same
   * answer being read twice on an unrelated re-render.
   */
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (running) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.text.trim()) return;
    if (announced.current === last.id) return;
    announced.current = last.id;
    // Only a turn this control started gets read back: a typed question should
    // not suddenly be answered out loud.
    if (useVoiceStore.getState().state === 'thinking') announce(last.text);
  }, [running, messages, announce]);

  if (!available.listen) {
    return (
      <p className="px-2.5 py-1 text-sm text-ink-faint">
        <span>This browser has no speech recognition, so voice is unavailable here.</span>
      </p>
    );
  }

  const listening = state === 'listening';
  const speaking = state === 'speaking';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={running && !listening}
          aria-pressed={listening}
          aria-label={listening ? 'Listening — release to send' : 'Hold to talk to the assistant'}
          onPointerDown={() => startListening(send)}
          onPointerUp={stopListening}
          // A pointer that leaves the button still ends the utterance: the
          // alternative is a microphone left open because a finger slid off.
          onPointerLeave={() => listening && stopListening()}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              if (!event.repeat) startListening(send);
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ' || event.key === 'Enter') stopListening();
          }}
          className={cx(
            'tap-target flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
            listening
              ? 'border-danger bg-danger/10 text-danger'
              : 'border-line text-ink-muted hover:border-line-strong hover:text-ink disabled:opacity-50',
          )}
        >
          <Mic aria-hidden className={cx('h-3.5 w-3.5', listening && 'animate-pulse')} />
          <span>{listening ? 'Listening' : 'Hold to talk'}</span>
        </button>

        {speaking && (
          <IconButton
            label="Stop the assistant speaking"
            size="xs"
            icon={<Square className="h-3 w-3" />}
            onClick={silence}
          />
        )}

        <IconButton
          label={replyAloud ? 'Turn spoken replies off' : 'Turn spoken replies on'}
          size="xs"
          icon={replyAloud ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          onClick={() => setReplyAloud(!replyAloud)}
        />

        {/* One live region for the whole control, so a screen reader is told
            what changed rather than having to poll the button's label. */}
        <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-sm text-ink-faint">
          {listening
            ? interim || 'Listening…'
            : state === 'thinking'
              ? 'Working on it…'
              : speaking
                ? 'Speaking — press stop to interrupt'
                : ''}
        </span>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 px-0.5 text-sm text-danger">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={dismissError} className="tap-target shrink-0 text-ink-faint hover:text-ink">
            <span>Dismiss</span>
          </button>
        </p>
      )}
    </div>
  );
}
