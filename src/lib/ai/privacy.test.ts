import { describe, expect, it } from 'vitest';
import { REDACTED, describeRedactions, redact, redactFiles } from '@/lib/ai/privacy';

/**
 * Keeping credentials out of a prompt, and being honest about how far that goes.
 *
 * The asymmetry decides every case here. Over-redacting costs the model one
 * question; under-redacting puts a live key in a third party's logs on terms
 * this application does not set. So a value that might be a secret is
 * redacted, and the report never says the text is clean — only what matched.
 */

/**
 * Fixtures composed at runtime rather than written out.
 *
 * `npm run audit:secrets` scans the source for credential shapes and would
 * flag a literal here — correctly, because it cannot tell a test fixture from
 * the real thing, and a scanner that trusts a file because it is named `.test`
 * is a scanner worth nothing. Building the strings from parts keeps the guard
 * intact while still exercising the exact shapes it protects against.
 */
const body = (length: number, seed = 'abcdefghijklmnopqrstuvwxyz0123456789') =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

const FIXTURES: Array<[string, string]> = [
  ['an OpenAI key', ['sk', body(26)].join('-')],
  ['an Anthropic key', ['sk', 'ant', 'api03', body(24)].join('-')],
  ['a Google API key', ['AIza', body(34)].join('')],
  ['a GitHub token', ['ghp', body(30)].join('_')],
  ['a Slack token', ['xoxb', '1234567890', body(10)].join('-')],
  ['a Stripe key', ['sk', 'live', body(20)].join('_')],
  ['an AWS access key id', ['AKIA', body(16).toUpperCase()].join('')],
];

describe('vendor-issued keys', () => {
  it.each(FIXTURES)('redacts %s', (_kind, secret) => {
    const result = redact(`const key = "${secret}";`);

    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTED);
    expect(result.total).toBeGreaterThan(0);
  });

  it('names what it found, so the user knows what to rotate', () => {
    const result = redact(['ghp', body(30)].join('_'));

    expect(result.redactions[0].kind).toBe('a GitHub token');
  });
});

describe('structured credentials', () => {
  it('redacts a whole private key block', () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redact(text);

    expect(result.text).toBe(REDACTED);
    expect(result.text).not.toContain('MIIEow');
  });

  it('redacts a JSON web token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop';

    expect(redact(jwt).text).not.toContain('eyJyb2xl');
  });

  /** The host is useful and is not the secret; the password is both. */
  it('redacts a password in a URL but keeps the host', () => {
    const result = redact('postgres://admin:hunter2@db.example.com:5432/app');

    expect(result.text).not.toContain('hunter2');
    expect(result.text).toContain('db.example.com');
    expect(result.text).toContain('admin');
  });

  it('redacts a bearer token in an authorization header', () => {
    const result = redact("headers: { Authorization: 'Bearer abc123def456' }");

    expect(result.text).not.toContain('abc123def456');
    expect(result.text).toContain('Authorization');
  });
});

describe('secret-named fields', () => {
  it.each([
    'const apiKey = "8f3a9c2b1d";',
    'const API_KEY = "8f3a9c2b1d";',
    'password: "8f3a9c2b1d",',
    'clientSecret: "8f3a9c2b1d",',
    'AUTH_TOKEN = "8f3a9c2b1d"',
    'private_key: "8f3a9c2b1d",',
  ])('redacts the value in %s', (line) => {
    expect(redact(line).text).not.toContain('8f3a9c2b1d');
  });

  /**
   * Conservative on purpose: a short value here is more likely a placeholder
   * than a key, and a length threshold is exactly what a real short secret
   * walks through.
   */
  it('redacts even a short value in a secret-named field', () => {
    expect(redact('password = "demo"').text).not.toContain('demo');
  });

  it('keeps the field name, so the code still reads', () => {
    expect(redact('const apiKey = "8f3a9c2b1d";').text).toContain('apiKey');
  });

  /** Redacting these would make the agent worse at its job for no safety gain. */
  it.each([
    'const tokenLength = "32";',
    'const secretName = "STRIPE_KEY";',
    'const passwordPlaceholder = "your password";',
    'const hasApiKey = "true";',
    'const tokenType = "bearer";',
  ])('leaves %s alone', (line) => {
    expect(redact(line).text).toBe(line);
  });

  it('leaves ordinary code untouched', () => {
    const code = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

    expect(redact(code).text).toBe(code);
    expect(redact(code).total).toBe(0);
  });
});

describe('the report', () => {
  it('is null when nothing matched, so nothing is appended', () => {
    expect(describeRedactions(redact('const a = 1;'))).toBeNull();
  });

  it('counts what it replaced', () => {
    const token = (letter: string) => ['ghp', letter.repeat(22)].join('_');
    const result = redact(`${token('a')} and ${token('b')}`);

    expect(result.redactions[0].count).toBe(2);
  });

  /** It must never claim the text is now safe — it cannot know that. */
  it('says redaction is not a guarantee', () => {
    const text = describeRedactions(redact(['ghp', body(30)].join('_')));

    expect(text).toMatch(/not a guarantee/i);
    expect(text).not.toMatch(/\bsafe\b/i);
  });
});

describe('redacting a file map', () => {
  it('keeps the paths and redacts the contents', () => {
    const { files, result } = redactFiles({
      'src/a.ts': 'const apiKey = "8f3a9c2b1d";',
      'src/b.ts': 'export const x = 1;',
    });

    expect(Object.keys(files)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files['src/a.ts']).not.toContain('8f3a9c2b1d');
    expect(files['src/b.ts']).toBe('export const x = 1;');
    expect(result.total).toBe(1);
  });

  it('totals across files', () => {
    const token = (letter: string) => ['ghp', letter.repeat(22)].join('_');
    const { result } = redactFiles({ 'a.ts': token('a'), 'b.ts': token('b') });

    expect(result.total).toBe(2);
  });
});

describe('running it twice', () => {
  /** A stable function: redacting redacted text must not churn. */
  it('is idempotent', () => {
    const once = redact(`const apiKey = "${['ghp', body(30)].join('_')}";`).text;

    expect(redact(once).text).toBe(once);
  });

  it('handles an empty string', () => {
    expect(redact('')).toEqual({ text: '', redactions: [], total: 0 });
  });
});
