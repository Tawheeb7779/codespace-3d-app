import { HttpError } from './http.ts';

/**
 * Supabase, over its own HTTP API.
 *
 * The GitHub functions reach Postgres through `supabase-js`, which is right for
 * them: they run several related queries and the client's query builder earns
 * its keep. This does two things — verify a token and count rows — and doing
 * them over `fetch` keeps the assistant proxy free of any import at all.
 *
 * That is not only tidiness. A function with no dependency is a function a test
 * can execute: stub `fetch`, call the handler, and the authentication and rate
 * limiting under test are the ones that will be deployed, not a re-description
 * of them.
 *
 * The service-role key is used exactly as `supabase-js` would use it — as the
 * `apikey` and bearer on a request to our own project — and never leaves this
 * file's outbound headers.
 */

function projectUrl(): string {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('SUPABASE_URL must be set');
  return url.replace(/\/+$/, '');
}

function serviceKey(): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set');
  return key;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
}

/**
 * Resolve the caller from their Supabase JWT.
 *
 * The token is handed to Supabase's own `/auth/v1/user`, which verifies the
 * signature and expiry. It is never decoded here: a `sub` claim read out of an
 * unverified token is a user id anybody can type, and trusting one would make
 * every check below decorative.
 *
 * Nothing else in the request is consulted for identity — not a body field, not
 * another header — so the id this returns is the only one a caller can get.
 */
export async function verifyUser(request: Request, signInMessage: string): Promise<AuthenticatedUser> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, signInMessage);

  let response: Response;
  try {
    response = await fetch(`${projectUrl()}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: serviceKey() },
    });
  } catch {
    throw new HttpError(503, 'Could not verify your session. Try again shortly.');
  }
  if (!response.ok) throw new HttpError(401, 'Your session has expired. Sign in again.');

  const user = (await response.json().catch(() => null)) as { id?: string; email?: string } | null;
  if (!user?.id) throw new HttpError(401, 'Your session has expired. Sign in again.');
  return { id: user.id, email: user.email ?? '' };
}

/**
 * How many rows a filter matches, without transferring any of them.
 *
 * `Prefer: count=exact` with an empty range asks PostgREST for the total in the
 * `content-range` header and no body, so a busy account costs one index scan
 * rather than a download of its history.
 */
export async function countRows(table: string, filters: Record<string, string>): Promise<number> {
  const url = new URL(`${projectUrl()}/rest/v1/${table}`);
  url.searchParams.set('select', 'id');
  for (const [column, filter] of Object.entries(filters)) url.searchParams.set(column, filter);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: serviceKey(),
        authorization: `Bearer ${serviceKey()}`,
        prefer: 'count=exact',
        range: '0-0',
      },
    });
  } catch {
    throw new HttpError(503, 'The assistant is unavailable right now. Try again shortly.');
  }
  if (!response.ok) {
    throw new HttpError(503, 'The assistant is unavailable right now. Try again shortly.');
  }
  // `items 0-0/57`, or `*/57` when the range is empty.
  const total = Number((response.headers.get('content-range') ?? '').split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

/** Insert one row. Returns whether it landed; never throws into a user's turn. */
export async function insertRow(table: string, row: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`${projectUrl()}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey(),
        authorization: `Bearer ${serviceKey()}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    return response.ok;
  } catch {
    return false;
  }
}
