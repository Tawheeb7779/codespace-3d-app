/**
 * What must not leave the browser inside a model prompt.
 *
 * The agent sends project text to a third-party provider. Most of a project is
 * exactly what it should send; a handful of things in it are credentials, and a
 * credential in a prompt is a credential in somebody else's logs, retained on
 * terms this application does not set and cannot revoke.
 *
 * So this redacts **conservatively**, and that word decides every judgement
 * call here: when a string might be a secret and might be an ordinary
 * identifier, it is redacted. The cost of over-redacting is an agent that has
 * to ask what a value is. The cost of under-redacting is a leaked key. Those
 * are not comparable, so the rule is not balanced between them.
 *
 * Two things this is **not**:
 *
 *   * Not the path filter. `isSensitivePath` already keeps `.env` and `.git`
 *     out of the agent's reach entirely, and that remains the primary control.
 *     This is the second layer, for a key pasted into a source file — which is
 *     where keys actually end up.
 *   * Not a promise. A secret with no recognisable shape, in a variable called
 *     `x`, survives this. The redaction report says how many matches were made
 *     so a reader can see it worked, and never claims the text is now clean.
 */

/** What one redaction replaced, for the caller to report honestly. */
export interface Redaction {
  /** The kind of value that matched, for a human-readable summary. */
  kind: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  /** Total replacements, so a caller can say "nothing matched" truthfully. */
  total: number;
}

/** The marker left behind, distinctive enough to grep for in a transcript. */
export const REDACTED = '[redacted]';

/**
 * Patterns for values that are credentials by their shape alone.
 *
 * Vendor prefixes first, because those are unambiguous and worth naming in the
 * report: "an OpenAI key was redacted" tells somebody exactly what to rotate.
 * The generic assignment rule comes last so a named match is not swallowed by
 * it.
 *
 * Ordering within the list is the evaluation order, and it matters: each
 * pattern runs against the text the previous one already redacted.
 */
const PATTERNS: Array<{ kind: string; pattern: RegExp; replace?: (match: string) => string }> = [
  // Vendor-issued keys. Each prefix is documented by its vendor, so a match is
  // a credential and not a coincidence.
  { kind: 'an OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'an Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'a Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { kind: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'a Stripe key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'a Supabase service-role key', pattern: /\bsbp_[A-Za-z0-9]{20,}/g },

  // A private key block. The header alone identifies it; the body is replaced
  // wholesale because a partial private key is still a disclosure.
  {
    kind: 'a private key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },

  // A JSON Web Token. Three base64url segments; the middle one is the payload,
  // which in a Supabase or Auth0 token names the project and the role.
  { kind: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },

  // A URL carrying credentials in its authority. The host is kept — it is the
  // useful part, and it is not the secret.
  {
    kind: 'a password in a URL',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (match) => match.replace(/:([^/\s@]+)@$/, `:${REDACTED}@`),
  },

  // An Authorization header, in code or in a pasted request.
  {
    kind: 'an authorization header',
    pattern: /\b(authorization\s*[:=]\s*['"`]?\s*(?:bearer|basic|token)\s+)([^\s'"`,;]+)/gi,
    replace: (match) => match.replace(/([^\s'"`,;]+)$/, REDACTED),
  },
];

/**
 * An assignment whose *name* says the value is a secret.
 *
 * This is the conservative rule, and the one that catches what the vendor
 * patterns cannot: `const apiKey = "8f3a9c..."`. It fires on the name, not the
 * value, so a real key in a well-named variable is caught whatever its shape.
 *
 * A short value is still redacted. `password = "demo"` is very likely a
 * placeholder, and redacting it costs the model one question; the alternative
 * is a length threshold that a real short secret walks straight through.
 */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(:|=)\s*(['"`])([^'"`\n]+)\3/g;

/**
 * The words that make a field name a secret-holder.
 *
 * Matched against the name as a whole rather than woven into the assignment
 * pattern, because a name that *is* the keyword — `apiKey`, `password` — has no
 * prefix, and a pattern demanding one silently misses the most common case.
 */
const SECRET_WORD =
  /(?:secret|password|passwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|client[_-]?secret|auth[_-]?token|session[_-]?key)/i;

/**
 * Names that read as secret-ish but hold no secret, so redacting them would
 * only make the agent worse at its job.
 *
 * Deliberately tiny. Every entry is a name whose value is structurally not a
 * credential — a length, a boolean, a type, a field name — and the list is not
 * a place to add "this one is fine really" for an actual value.
 */
const NOT_A_SECRET = /^(?:.*(?:_?(?:length|len|size|count|type|name|field|label|prefix|suffix|pattern|regex|placeholder|required|enabled|expiry|expires|ttl))|has[A-Z].*|is[A-Z].*)$/i;

/**
 * Redact what is recognisably a credential, and report what was replaced.
 *
 * Pure: the input string is never modified, and calling this twice on the same
 * text gives the same answer. The report is the point as much as the text —
 * a caller that says "3 values were redacted before sending" is telling the
 * user something true, and one that says "your project is safe to send" is
 * not, which is why nothing here returns a verdict.
 */
export function redact(text: string): RedactionResult {
  if (!text) return { text, redactions: [], total: 0 };

  let out = text;
  const redactions: Redaction[] = [];

  for (const entry of PATTERNS) {
    let count = 0;
    out = out.replace(entry.pattern, (match) => {
      count += 1;
      return entry.replace ? entry.replace(match) : REDACTED;
    });
    if (count) redactions.push({ kind: entry.kind, count });
  }

  let named = 0;
  out = out.replace(ASSIGNMENT, (match, name: string, operator: string, quote: string, value: string) => {
    if (!SECRET_WORD.test(name) || NOT_A_SECRET.test(name)) return match;
    // Already redacted by a pattern above: counting it twice would overstate
    // what this pass found.
    if (value === REDACTED) return match;
    named += 1;
    return `${name}${operator === ':' ? ':' : ' ='} ${quote}${REDACTED}${quote}`;
  });
  if (named) redactions.push({ kind: 'a value in a secret-named field', count: named });

  return { text: out, redactions, total: redactions.reduce((sum, entry) => sum + entry.count, 0) };
}

/**
 * A sentence describing what was removed, or null when nothing was.
 *
 * Null rather than "nothing was redacted": a caller appending this to a prompt
 * should append nothing, and a caller showing it to a user should show nothing,
 * and both of those are easier to get right when the empty case is empty.
 */
export function describeRedactions(result: RedactionResult): string | null {
  if (!result.total) return null;
  const parts = result.redactions.map(
    (entry) => `${entry.count} × ${entry.kind}`,
  );
  return `Redacted before sending: ${parts.join(', ')}. Redaction matches known credential shapes and secret-looking field names; it is not a guarantee that no secret remains.`;
}

/**
 * Redact every value in a record, keeping the keys.
 *
 * For file maps: a path is not a secret and is needed to make sense of the
 * content, so paths pass through untouched.
 */
export function redactFiles(files: Record<string, string>): {
  files: Record<string, string>;
  result: RedactionResult;
} {
  const out: Record<string, string> = {};
  const redactions = new Map<string, number>();
  let total = 0;

  for (const [path, content] of Object.entries(files)) {
    const result = redact(content);
    out[path] = result.text;
    total += result.total;
    for (const entry of result.redactions) {
      redactions.set(entry.kind, (redactions.get(entry.kind) ?? 0) + entry.count);
    }
  }

  return {
    files: out,
    result: {
      text: '',
      redactions: [...redactions.entries()].map(([kind, count]) => ({ kind, count })),
      total,
    },
  };
}
