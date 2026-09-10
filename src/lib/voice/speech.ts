/**
 * The browser's own speech engines, behind a shape this app can test.
 *
 * Two Web APIs, both optional and both differently prefixed, wrapped so the
 * rest of the app never touches `webkitSpeechRecognition` or asks whether
 * `speechSynthesis` exists. Nothing here is a fallback: with no engine, these
 * report that they are unavailable and the UI says so. A voice mode that
 * silently degrades to a text box the person is talking at is worse than one
 * that tells them their browser cannot do this.
 *
 * **The microphone is never open except while listening.** `start` is called
 * from a press, `stop` from its release or from a click, and there is no path
 * that begins recognition on mount, on focus, or on a wake word. Recognition is
 * `continuous: false`, so the engine itself closes the stream at the end of an
 * utterance rather than holding it open between turns.
 *
 * **Nothing is uploaded by this file.** Recognition happens in the browser's
 * own engine — which, on some browsers, is a cloud service belonging to the
 * *browser vendor*, not to this app. That is a property of the platform, worth
 * saying plainly in the UI, and not something this wrapper can change.
 */

/** The subset of `SpeechRecognition` used here, since TS does not ship it. */
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

type RecognitionConstructor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Whether this browser can turn speech into text at all. */
export function speechToTextAvailable(): boolean {
  return recognitionConstructor() !== null;
}

/** Whether this browser can speak. Independent of the above — one may exist alone. */
export function textToSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Why listening stopped, in words a person can act on. */
export type ListenErrorKind =
  | 'not-allowed'
  | 'no-speech'
  | 'audio-capture'
  | 'network'
  | 'aborted'
  | 'unknown';

export const LISTEN_ERROR_MESSAGE: Record<ListenErrorKind, string> = {
  'not-allowed':
    'Microphone access was refused. Allow it for this site in your browser’s address bar, then try again.',
  'no-speech': 'Nothing was heard. Hold the button and speak, then release.',
  'audio-capture': 'No microphone was found.',
  network: 'The speech service could not be reached.',
  aborted: 'Listening stopped.',
  unknown: 'Speech recognition failed.',
};

function classifyError(raw: unknown): ListenErrorKind {
  const code = typeof raw === 'string' ? raw : '';
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'not-allowed';
  if (code === 'no-speech') return 'no-speech';
  if (code === 'audio-capture') return 'audio-capture';
  if (code === 'network') return 'network';
  if (code === 'aborted') return 'aborted';
  return 'unknown';
}

export interface ListenHandlers {
  /** Fired as the engine revises its guess. Never treated as a command. */
  onInterim: (text: string) => void;
  /** The utterance the engine settled on. */
  onFinal: (text: string) => void;
  onError: (kind: ListenErrorKind) => void;
  /** The microphone is closed by the time this runs. */
  onEnd: () => void;
  /** The engine has the microphone open. */
  onStart?: () => void;
}

export interface ListenHandle {
  /** Finish the utterance and let the final result arrive. */
  stop: () => void;
  /** Drop the utterance entirely. Nothing is delivered. */
  abort: () => void;
}

/**
 * Listen for one utterance.
 *
 * Returns null when this browser has no engine, so a caller cannot mistake an
 * inert handle for a live microphone.
 */
export function listenOnce(handlers: ListenHandlers, lang?: string): ListenHandle | null {
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;

  const recognition = new Recognition();
  // One utterance per press. `continuous` would leave the microphone open
  // between turns, which is exactly the background listening this must not do.
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

  let settled = false;

  recognition.onstart = () => handlers.onStart?.();

  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) {
        settled = true;
        const final = text.trim();
        if (final) handlers.onFinal(final);
      } else {
        interim += text;
      }
    }
    if (interim.trim()) handlers.onInterim(interim.trim());
  };

  recognition.onerror = (event) => {
    const kind = classifyError(event?.error);
    // An abort is this app stopping the engine on purpose; reporting it as a
    // failure would put an error on screen for a button the person just pressed.
    if (kind !== 'aborted') handlers.onError(kind);
  };

  recognition.onend = () => {
    // A press that produced nothing is worth saying, because silence looks
    // identical to a microphone that never opened.
    if (!settled) handlers.onError('no-speech');
    handlers.onEnd();
  };

  try {
    recognition.start();
  } catch {
    // Starting twice throws; the caller's state machine prevents it, and this
    // keeps a thrown platform error from escaping into a click handler.
    handlers.onError('unknown');
    handlers.onEnd();
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
    abort: () => {
      settled = true; // Nothing is owed to the caller for an abandoned utterance.
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * Speak text, and report when it is finished.
 *
 * Long answers are chunked at sentence boundaries: several engines truncate a
 * single very long utterance, and a reply that stops mid-sentence reads as the
 * agent having stopped working.
 */
export function speak(
  text: string,
  handlers: { onEnd: () => void; onError?: () => void },
  lang?: string,
): boolean {
  if (!textToSpeechAvailable()) return false;
  const clean = spokenForm(text);
  if (!clean) return false;

  window.speechSynthesis.cancel();
  const chunks = chunkForSpeech(clean);
  let remaining = chunks.length;

  for (const chunk of chunks) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    utterance.onend = () => {
      remaining -= 1;
      if (remaining <= 0) handlers.onEnd();
    };
    utterance.onerror = () => {
      remaining -= 1;
      handlers.onError?.();
      if (remaining <= 0) handlers.onEnd();
    };
    window.speechSynthesis.speak(utterance);
  }
  return true;
}

/** Stop speaking immediately. Safe to call when nothing is speaking. */
export function stopSpeaking(): void {
  if (!textToSpeechAvailable()) return;
  window.speechSynthesis.cancel();
}

/**
 * The readable part of an answer.
 *
 * A reply from a coding agent is full of code fences, paths and markdown.
 * Reading a fenced block aloud character by character is unusable, so blocks
 * are replaced by a short spoken note and the code stays on screen where it
 * belongs — the transcript is the record, speech is the summary of it.
 */
export function spokenForm(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block — see the transcript) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Longest utterance to hand the engine in one go. */
const MAX_CHUNK = 220;

/** Split at sentence ends, then hard-wrap anything still too long. */
export function chunkForSpeech(text: string, max = MAX_CHUNK): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      for (let index = 0; index < sentence.length; index += max) {
        chunks.push(sentence.slice(index, index + max).trim());
      }
      continue;
    }
    if ((current + sentence).length > max) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
