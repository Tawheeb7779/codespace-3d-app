/**
 * One error type for everything that can go wrong between Forge and GitHub,
 * carrying enough structure that the UI can react (retry, reconnect, explain)
 * instead of printing a status code at the user.
 */

export type GithubErrorKind =
  | 'not-connected'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'validation'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'malformed';

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | null;
  /** Unix seconds when a rate limit window resets, when GitHub told us. */
  readonly retryAt: number | null;
  /** True when reconnecting the GitHub account is the way out. */
  readonly needsReconnect: boolean;

  constructor(
    kind: GithubErrorKind,
    message: string,
    options: { status?: number | null; retryAt?: number | null } = {},
  ) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAt = options.retryAt ?? null;
    this.needsReconnect = kind === 'unauthorized' || kind === 'not-connected';
  }
}

/**
 * Map an HTTP response onto the taxonomy above.
 *
 * GitHub overloads 403: it is both "you may not do that" and "you have spent
 * your request budget". The rate-limit headers are what tell them apart, and
 * getting that wrong would send a user to reconnect their account when all
 * they need is to wait.
 */
export function errorFromResponse(
  status: number,
  headers: { get(name: string): string | null },
  body: unknown,
): GithubError {
  const message =
    (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : '') || `GitHub returned HTTP ${status}`;

  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  const retryAfter = Number(headers.get('retry-after'));
  const retryAt = Number.isFinite(reset) && reset > 0
    ? reset
    : Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.floor(Date.now() / 1000) + retryAfter
      : null;

  const rateLimited =
    status === 429 || ((status === 403) && Number.isFinite(remaining) && remaining === 0);

  if (rateLimited) {
    const when = retryAt ? new Date(retryAt * 1000).toLocaleTimeString() : 'shortly';
    return new GithubError(
      'rate-limited',
      `GitHub rate limit reached. Requests resume around ${when}.`,
      { status, retryAt },
    );
  }

  switch (status) {
    case 401:
      return new GithubError(
        'unauthorized',
        'GitHub rejected the credentials. Reconnect your GitHub account.',
        { status },
      );
    case 403:
      return new GithubError(
        'forbidden',
        message || 'The connected GitHub account is not allowed to do that.',
        { status },
      );
    case 404:
      return new GithubError(
        'not-found',
        message || 'GitHub could not find that repository, branch or object.',
        { status },
      );
    case 409:
      return new GithubError('conflict', message || 'GitHub reported a conflict.', { status });
    case 422:
      return new GithubError('validation', message || 'GitHub rejected the request as invalid.', {
        status,
      });
    default:
      if (status >= 500) {
        return new GithubError('server', `GitHub is having trouble (HTTP ${status}). Try again.`, {
          status,
        });
      }
      return new GithubError('malformed', message, { status });
  }
}
