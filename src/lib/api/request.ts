/**
 * Building and sending an HTTP request, from the browser.
 *
 * **The browser is the boundary, deliberately.** A request goes out through
 * `fetch` from the page, with the page's own origin and the user's own network
 * — it is not relayed through TA CODE's server. That costs something real:
 * CORS applies, and a service that does not allow this origin cannot be called
 * from here. It buys something worth more: there is no server-side fetcher that
 * an arbitrary URL can be aimed at, so nothing here can be turned into a probe
 * of a private network. A proxy would remove the CORS limit and add exactly
 * that hole, and the limit is the honest trade.
 *
 * **Secret values are session-only.** A variable marked secret is held in
 * memory for as long as the tab is open and is never written to storage. This
 * is the same rule TA CODE's own security scanner enforces on a user's code —
 * a token in `localStorage` is readable by anything running on the page — and
 * an API client that broke it while flagging it elsewhere would be worth
 * nothing.
 *
 * **Secrets are redacted everywhere they are shown.** The request preview and
 * the saved history hold the substituted request with secret values masked, so
 * a screenshot of a working call does not publish the token that made it work.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type AuthConfig =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'header'; name: string; value: string };

export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  headers: KeyValue[];
  params: KeyValue[];
  body: string;
  auth: AuthConfig;
}

export interface Variable {
  key: string;
  value: string;
  /** Never persisted, and masked wherever the request is displayed. */
  secret: boolean;
}

/** Largest response body kept in memory. A download is not an inspection. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** How long a request may run before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Replace `{{name}}` with a variable's value.
 *
 * An unknown name is left exactly as written rather than blanked. Substituting
 * an empty string would send a request to `https://api./v1/x` and produce a
 * confusing failure; leaving the placeholder visible makes the mistake obvious
 * in the URL bar and in the error.
 */
export function substitute(text: string, variables: Variable[]): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) => {
    const found = variables.find((variable) => variable.key === name);
    return found ? found.value : whole;
  });
}

/** Which variables a piece of text refers to, whether or not they exist. */
export function referencedVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) found.add(match[1]);
  return [...found];
}

/**
 * Mask every secret value that appears in a string.
 *
 * Applied to anything shown or stored: a substituted URL, a header preview, a
 * saved history entry. Longest values first so one secret that contains another
 * is masked whole rather than leaving a fragment behind.
 */
export function redactSecrets(text: string, variables: Variable[]): string {
  const secrets = variables
    .filter((variable) => variable.secret && variable.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const secret of secrets) out = out.split(secret.value).join('••••••');
  return out;
}

export interface BuiltRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** What went wrong before anything was sent. */
  error?: string;
}

/**
 * Turn a saved request into the thing that will actually be sent.
 *
 * Validation happens here rather than at send time so a bad URL is a message
 * beside the field, not a thrown exception from `fetch` that reads as a network
 * failure.
 */
export function buildRequest(request: ApiRequest, variables: Variable[]): BuiltRequest {
  const raw = substitute(request.url, variables).trim();
  if (!raw) {
    return { method: request.method, url: '', headers: {}, error: 'Enter a URL.' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      method: request.method,
      url: raw,
      headers: {},
      error: `"${raw}" is not a complete URL. Include the scheme, for example https://.`,
    };
  }

  /*
   * Only http and https.
   *
   * `file:` would read the user's disk, `javascript:` would execute, and a
   * request builder is not the place to offer either. Refused by name so the
   * message says what is wrong rather than failing obscurely inside `fetch`.
   */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      method: request.method,
      url: raw,
      headers: {},
      error: `${url.protocol} is not a scheme this can request. Use http or https.`,
    };
  }

  for (const param of request.params) {
    if (!param.enabled || !param.key.trim()) continue;
    url.searchParams.set(substitute(param.key, variables), substitute(param.value, variables));
  }

  const headers: Record<string, string> = {};
  for (const header of request.headers) {
    if (!header.enabled || !header.key.trim()) continue;
    headers[substitute(header.key, variables).trim()] = substitute(header.value, variables);
  }

  const auth = request.auth;
  if (auth.kind === 'bearer' && auth.token.trim()) {
    headers.Authorization = `Bearer ${substitute(auth.token, variables)}`;
  } else if (auth.kind === 'basic') {
    const user = substitute(auth.username, variables);
    const password = substitute(auth.password, variables);
    headers.Authorization = `Basic ${btoa(`${user}:${password}`)}`;
  } else if (auth.kind === 'header' && auth.name.trim()) {
    headers[substitute(auth.name, variables).trim()] = substitute(auth.value, variables);
  }

  // A body on GET or HEAD is refused by `fetch` itself; dropping it here keeps
  // that from surfacing as an unexplained TypeError.
  const sendsBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = sendsBody && request.body.trim() ? substitute(request.body, variables) : undefined;

  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    // Only when it really is JSON. Guessing wrong would make a server reject a
    // form body for the wrong reason.
    if (looksLikeJson(body)) headers['Content-Type'] = 'application/json';
  }

  return { method: request.method, url: url.toString(), headers, body };
}

export function looksLikeJson(text: string): boolean {
  const clean = text.trim();
  if (!clean.startsWith('{') && !clean.startsWith('[')) return false;
  try {
    JSON.parse(clean);
    return true;
  } catch {
    return false;
  }
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Array<{ key: string; value: string }>;
  body: string;
  /** Bytes received, before any truncation for display. */
  size: number;
  /** Milliseconds from send to the body being read. */
  durationMs: number;
  truncated: boolean;
}

export type RequestFailureKind = 'cors' | 'network' | 'timeout' | 'invalid';

export interface RequestFailure {
  kind: RequestFailureKind;
  message: string;
}

/**
 * What a failed `fetch` actually means.
 *
 * The browser deliberately gives a cross-origin refusal the same opaque
 * `TypeError` as a DNS failure, so this cannot *know* which happened. It says
 * so, and names CORS first because it is overwhelmingly the common case here
 * and the one people misdiagnose as "the API is down" — but it is phrased as
 * the likely explanation rather than the verdict.
 */
export function classifyFailure(error: unknown): RequestFailure {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      kind: 'timeout',
      message: `The request was still running after ${REQUEST_TIMEOUT_MS / 1000} seconds and was abandoned.`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|load failed|networkerror/i.test(message)) {
    return {
      kind: 'cors',
      message:
        'The browser blocked the response and does not say why. The usual cause is CORS: the ' +
        'service did not allow this origin. It could also be that the host is unreachable or the ' +
        'connection was refused — the browser gives all three the same opaque error, so this ' +
        'cannot tell them apart. A request that works in curl and not here is almost always CORS.',
    };
  }
  return { kind: 'network', message };
}

export interface SendResult {
  response?: ApiResponse;
  failure?: RequestFailure;
}

/**
 * Send it, and read what came back.
 *
 * `fetch` from this page: no relay, no server-side fetcher, and therefore no
 * way to aim this at a network the browser could not already reach.
 */
export async function sendRequest(
  built: BuiltRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (built.error) return { failure: { kind: 'invalid', message: built.error } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();

  try {
    const response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      signal: controller.signal,
      // No cookies to a third party by default: an API client that silently
      // attached the user's session to every host would be a confused-deputy
      // problem waiting to happen.
      credentials: 'omit',
      redirect: 'follow',
    });

    const text = await response.text();
    const durationMs = Math.round(performance.now() - started);
    const truncated = text.length > MAX_RESPONSE_BYTES;

    const headers: Array<{ key: string; value: string }> = [];
    response.headers.forEach((value, key) => headers.push({ key, value }));

    return {
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: headers.sort((a, b) => a.key.localeCompare(b.key)),
        body: truncated ? text.slice(0, MAX_RESPONSE_BYTES) : text,
        size: text.length,
        durationMs,
        truncated,
      },
    };
  } catch (error) {
    return { failure: classifyFailure(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pretty-print a JSON body; leave anything else exactly as it arrived. */
export function formatBody(body: string): string {
  if (!looksLikeJson(body)) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function statusTone(status: number): 'positive' | 'caution' | 'danger' | 'neutral' {
  if (status >= 200 && status < 300) return 'positive';
  if (status >= 300 && status < 400) return 'neutral';
  if (status >= 400 && status < 500) return 'caution';
  return 'danger';
}
