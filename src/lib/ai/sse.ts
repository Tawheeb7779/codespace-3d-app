/**
 * Server-sent events, as every streaming model API actually sends them.
 *
 * This is the wire format and nothing above it: no provider names, no JSON, no
 * knowledge of what a chunk means. That separation is deliberate — the framing
 * bugs and the interpretation bugs are different bugs, and the framing ones are
 * the ones that only appear against a real network.
 *
 * Three of them are what this file exists for:
 *
 *  - A frame does not arrive in one read. TCP splits wherever it likes, so
 *    `data: {"cho` and `ices":[…]}\n\n` are two reads of one event, and a parser
 *    that treats each read as a frame drops most of the response.
 *  - A multi-byte character can be split across reads too, which is why
 *    `TextDecoder` is used in streaming mode rather than decoding each chunk.
 *    Without it an Arabic or emoji token arrives as replacement characters.
 *  - Comment lines (`: keep-alive`) and `ping` events are traffic, not content.
 *    They exist to hold the connection open and must not be mistaken for data.
 */

export interface SseFrame {
  /** The `event:` field, or `''` when the provider sent none. */
  event: string;
  /** The `data:` field. Multiple data lines are joined with newlines, per spec. */
  data: string;
}

/**
 * One frame's worth of lines, parsed.
 *
 * Returns null for a frame that carried nothing — a lone comment, or the empty
 * remainder after the last separator — so a keep-alive does not reach the
 * caller as an event with no content to interpret.
 */
function parseFrame(raw: string): SseFrame | null {
  let event = '';
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    // A blank line cannot occur inside a frame, and a leading colon is a
    // comment: both are skipped rather than parsed as a field.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Exactly one leading space is part of the framing, not the value.
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // Other fields (`id`, `retry`) are valid and irrelevant here.
  }

  if (!event && !data.length) return null;
  return { event, data: data.join('\n') };
}

/**
 * Read a response body as a sequence of events.
 *
 * The body is always released. A consumer that stops early — a `break` on the
 * terminating event, or a throw while interpreting one — would otherwise leave
 * the connection open for the life of the page, which is how a cancelled
 * generation keeps costing money after the user has stopped watching.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalised on the whole buffer, so a CRLF split across two reads is
      // still one line ending by the time it is looked for.
      buffer = buffer.replace(/\r\n/g, '\n');

      for (let split = buffer.indexOf('\n\n'); split !== -1; split = buffer.indexOf('\n\n')) {
        const frame = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (frame) yield frame;
      }
    }

    // A provider that closes without a final blank line has still sent a
    // complete frame, and it is usually the one carrying the stop reason.
    buffer += decoder.decode();
    const tail = parseFrame(buffer.replace(/\r\n/g, '\n'));
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
