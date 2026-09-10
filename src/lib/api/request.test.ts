import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRequest,
  classifyFailure,
  formatBody,
  redactSecrets,
  referencedVariables,
  sendRequest,
  statusTone,
  substitute,
  type ApiRequest,
  type Variable,
} from '@/lib/api/request';
import { useApiStore } from '@/stores/apiStore';

/**
 * An API client, and the three things it must not do.
 *
 * It must not become a server-side fetcher. Requests go out through the page's
 * own `fetch`, so nothing here can be aimed at a network the browser could not
 * already reach. That means CORS applies, and the error for it must say so —
 * the browser gives a cross-origin refusal the same opaque failure as an
 * unreachable host, and "the API is down" is the wrong conclusion people reach.
 *
 * It must not leak a secret into anything that is stored or displayed. A token
 * in a URL, in the history, or in a screenshot of a working call is a token
 * that has escaped.
 *
 * And it must not persist a secret at all. TA CODE's own scanner flags a
 * credential in `localStorage` as a high-severity finding in a user's project;
 * doing it here would be worth nothing.
 */

const request = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  id: 'r1',
  name: 'Test',
  method: 'GET',
  url: 'https://api.example.test/things',
  headers: [],
  params: [],
  body: '',
  auth: { kind: 'none' },
  ...over,
});

const variable = (key: string, value: string, secret = false): Variable => ({ key, value, secret });

describe('filling in variables', () => {
  it('replaces a named placeholder', () => {
    expect(substitute('{{host}}/v1', [variable('host', 'https://x.test')])).toBe('https://x.test/v1');
  });

  it('tolerates spaces inside the braces', () => {
    expect(substitute('{{ host }}/v1', [variable('host', 'https://x.test')])).toBe(
      'https://x.test/v1',
    );
  });

  /**
   * Blanking an unknown name would send a request to `https://api./v1` and
   * produce a confusing failure. Leaving it visible makes the mistake obvious.
   */
  it('leaves an unknown placeholder exactly as written', () => {
    expect(substitute('{{missing}}/v1', [])).toBe('{{missing}}/v1');
  });

  it('lists what a request refers to, known or not', () => {
    expect(referencedVariables('{{host}}/{{version}}/x').sort()).toEqual(['host', 'version']);
  });
});

describe('redacting secrets', () => {
  it('masks a secret value wherever it appears', () => {
    const masked = redactSecrets('Bearer tok_live_abcdef', [variable('t', 'tok_live_abcdef', true)]);

    expect(masked).not.toContain('tok_live_abcdef');
    expect(masked).toContain('••••••');
  });

  it('leaves a value that is not marked secret alone', () => {
    expect(redactSecrets('https://api.test/v1', [variable('h', 'https://api.test')])).toContain(
      'https://api.test',
    );
  });

  /** A shorter secret inside a longer one must not leave a fragment behind. */
  it('masks the longest secret first', () => {
    const masked = redactSecrets('abcdef123456', [
      variable('short', 'abcdef', true),
      variable('long', 'abcdef123456', true),
    ]);

    expect(masked).toBe('••••••');
  });

  it('ignores a secret too short to be one, so it cannot mask ordinary text', () => {
    expect(redactSecrets('a test of things', [variable('x', 'of', true)])).toBe('a test of things');
  });
});

describe('building the request', () => {
  it('refuses an empty URL with a message rather than a thrown error', () => {
    expect(buildRequest(request({ url: '' }), []).error).toMatch(/enter a url/i);
  });

  it('explains a URL with no scheme instead of failing inside fetch', () => {
    expect(buildRequest(request({ url: 'api.example.test' }), []).error).toMatch(/scheme/i);
  });

  /** `file:` would read the disk and `javascript:` would execute. */
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x'])(
    'refuses the scheme in %j',
    (url) => {
      expect(buildRequest(request({ url }), []).error).toBeTruthy();
    },
  );

  it('appends enabled query parameters and skips disabled ones', () => {
    const built = buildRequest(
      request({
        params: [
          { id: '1', key: 'page', value: '2', enabled: true },
          { id: '2', key: 'debug', value: 'true', enabled: false },
        ],
      }),
      [],
    );

    expect(built.url).toContain('page=2');
    expect(built.url).not.toContain('debug');
  });

  it('substitutes variables in the URL, headers and body', () => {
    const built = buildRequest(
      request({
        method: 'POST',
        url: '{{host}}/v1',
        headers: [{ id: '1', key: 'X-Env', value: '{{env}}', enabled: true }],
        body: '{"env":"{{env}}"}',
      }),
      [variable('host', 'https://x.test'), variable('env', 'staging')],
    );

    expect(built.url).toBe('https://x.test/v1');
    expect(built.headers['X-Env']).toBe('staging');
    expect(built.body).toContain('staging');
  });

  it('builds a bearer header from the token', () => {
    const built = buildRequest(request({ auth: { kind: 'bearer', token: 'abc' } }), []);

    expect(built.headers.Authorization).toBe('Bearer abc');
  });

  it('encodes basic credentials', () => {
    const built = buildRequest(
      request({ auth: { kind: 'basic', username: 'amina', password: 'pw' } }),
      [],
    );

    expect(built.headers.Authorization).toBe(`Basic ${btoa('amina:pw')}`);
  });

  /** `fetch` refuses a body on GET; dropping it avoids an unexplained TypeError. */
  it('does not send a body on GET', () => {
    expect(buildRequest(request({ method: 'GET', body: '{"a":1}' }), []).body).toBeUndefined();
  });

  it('sets a JSON content type only when the body really is JSON', () => {
    const json = buildRequest(request({ method: 'POST', body: '{"a":1}' }), []);
    const form = buildRequest(request({ method: 'POST', body: 'a=1&b=2' }), []);

    expect(json.headers['Content-Type']).toBe('application/json');
    expect(form.headers['Content-Type']).toBeUndefined();
  });

  it('does not override a content type the request already sets', () => {
    const built = buildRequest(
      request({
        method: 'POST',
        body: '{"a":1}',
        headers: [{ id: '1', key: 'content-type', value: 'application/vnd.api+json', enabled: true }],
      }),
      [],
    );

    expect(built.headers['content-type']).toBe('application/vnd.api+json');
    expect(built.headers['Content-Type']).toBeUndefined();
  });
});

describe('when a request fails', () => {
  /**
   * The browser gives a cross-origin refusal the same opaque error as a DNS
   * failure, so this cannot know which happened — and must not pretend to.
   */
  it('names CORS as the likely cause without claiming to be certain', () => {
    const failure = classifyFailure(new TypeError('Failed to fetch'));

    expect(failure.kind).toBe('cors');
    expect(failure.message).toMatch(/cors/i);
    expect(failure.message).toMatch(/cannot tell them apart|could also be/i);
  });

  it('reports a timeout as a timeout', () => {
    const failure = classifyFailure(new DOMException('aborted', 'AbortError'));

    expect(failure.kind).toBe('timeout');
  });
});

describe('sending', () => {
  it('returns the status, headers, body and timing', async () => {
    const fake = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await sendRequest(buildRequest(request(), []), fake as unknown as typeof fetch);

    expect(result.response?.status).toBe(201);
    expect(result.response?.body).toBe('{"ok":true}');
    expect(result.response?.headers.some((header) => header.key === 'content-type')).toBe(true);
    expect(result.response?.durationMs).toBeGreaterThanOrEqual(0);
  });

  /** A 500 is a response, not a failure of the client. */
  it('treats a server error as a response, not as a failure', async () => {
    const fake = vi.fn(async () => new Response('nope', { status: 500 }));

    const result = await sendRequest(buildRequest(request(), []), fake as unknown as typeof fetch);

    expect(result.response?.status).toBe(500);
    expect(result.failure).toBeUndefined();
  });

  it('does not send at all when the request could not be built', async () => {
    const fake = vi.fn();

    const result = await sendRequest(
      buildRequest(request({ url: 'not a url' }), []),
      fake as unknown as typeof fetch,
    );

    expect(fake).not.toHaveBeenCalled();
    expect(result.failure?.kind).toBe('invalid');
  });

  /**
   * Attaching the user's session to every host would make this a confused
   * deputy for any service that trusts a cookie.
   */
  it('sends no credentials to a third party', async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('ok');
    }) as unknown as typeof fetch;

    await sendRequest(buildRequest(request(), []), fake);

    expect(seen[0]).toMatchObject({ credentials: 'omit' });
  });
});

describe('displaying a response', () => {
  it('pretty-prints JSON', () => {
    expect(formatBody('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('leaves anything that is not JSON exactly as it arrived', () => {
    expect(formatBody('<html></html>')).toBe('<html></html>');
  });

  it.each([
    [200, 'positive'],
    [301, 'neutral'],
    [404, 'caution'],
    [500, 'danger'],
  ])('reads %i as %s', (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });
});

describe('what survives a reload', () => {
  beforeEach(() => {
    useApiStore.setState({
      requests: [],
      activeId: null,
      variables: { development: [], preview: [], production: [] },
      environment: 'development',
      history: [],
      response: null,
      failure: null,
      running: false,
    });
  });

  /**
   * The rule TA CODE's own scanner enforces on a user's code, applied here: a
   * token in browser storage is readable by anything running on the page.
   */
  it('never writes a secret value to storage', () => {
    useApiStore.getState().setVariables('development', [
      variable('host', 'https://x.test'),
      variable('token', 'tok_live_secret', true),
    ]);

    const persisted = JSON.parse(localStorage.getItem('ta-code-api') ?? '{}') as {
      state?: { variables?: Record<string, Variable[]> };
    };
    const saved = persisted.state?.variables?.development ?? [];

    expect(saved.find((entry) => entry.key === 'token')?.value).toBe('');
    // The name is kept, so the request still shows what it needs.
    expect(saved.find((entry) => entry.key === 'token')).toBeTruthy();
    // A value that is not secret is ordinary configuration and is kept.
    expect(saved.find((entry) => entry.key === 'host')?.value).toBe('https://x.test');
  });

  it('does not persist a response body', () => {
    useApiStore.setState({
      response: {
        status: 200,
        statusText: 'OK',
        headers: [],
        body: 'somebody-elses-data',
        size: 19,
        durationMs: 1,
        truncated: false,
      },
    });

    expect(localStorage.getItem('ta-code-api') ?? '').not.toContain('somebody-elses-data');
  });
});
