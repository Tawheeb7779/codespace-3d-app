/**
 * The HTTP shapes every TA CODE Edge Function shares.
 *
 * Deliberately dependency-free — no imports at all. Everything here can run
 * anywhere a `Request` and a `Response` exist, which is what lets the functions
 * that use it be executed by a test rather than only deployed and hoped for.
 */

/**
 * `FORGE_APP_ORIGIN` when set, so a browser refuses a response meant for
 * another site. `*` is the fallback rather than the intent: these functions
 * authenticate by an `Authorization` header and never by a cookie, so a
 * cross-origin page cannot make an authenticated call with ambient
 * credentials. `access-control-allow-credentials` is deliberately absent.
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': Deno.env.get('FORGE_APP_ORIGIN') ?? '*',
  'access-control-allow-headers': 'authorization, content-type, apikey',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '600',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...headers },
  });
}

export function fail(status: number, message: string): Response {
  return json({ message }, status);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** An integer from the environment, or the default when unset or nonsense. */
export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
