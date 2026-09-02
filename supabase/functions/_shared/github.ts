/**
 * Shared server-side helpers for the GitHub Edge Functions.
 *
 * Everything in this directory runs on Supabase Edge Functions (Deno), never
 * in a browser. It is the only place a GitHub credential exists in plaintext:
 * the token is read from `private.github_tokens` with the service-role key,
 * attached to an outbound request, and dropped. It is never returned to the
 * caller, never logged, and never placed in a URL.
 */

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const GITHUB_API = 'https://api.github.com';

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': Deno.env.get('FORGE_APP_ORIGIN') ?? '*',
  'access-control-allow-headers': 'authorization, content-type',
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

/** Service-role client. Bypasses RLS, so it never sees a user-supplied filter. */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Resolve the caller from their Supabase JWT.
 *
 * The token is verified by Supabase, not parsed here: a forged `sub` claim
 * would otherwise be enough to act as any user.
 */
export async function requireUser(request: Request): Promise<{ id: string; email: string }> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in to use the GitHub integration.');
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  return { id: data.user.id, email: data.user.email ?? '' };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The caller's role on a project, straight from the same helper RLS uses. */
export async function projectRole(userId: string, projectId: string): Promise<string | null> {
  const client = serviceClient();
  const { data: project } = await client
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return null;
  if (project.owner_id === userId) return 'owner';

  const { data: member } = await client
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  return member?.role ?? null;
}

const RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function atLeast(role: string | null, minimum: string): boolean {
  return Boolean(role) && (RANK[role!] ?? 0) >= (RANK[minimum] ?? 0);
}

/** Read the stored credential. Returns null when the user has not connected. */
export async function accessTokenFor(userId: string): Promise<string | null> {
  const { data } = await serviceClient()
    .schema('private')
    .from('github_tokens')
    .select('access_token, expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data?.access_token) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.access_token as string;
}

/** Mark a connection revoked so the UI can explain the 401 it just saw. */
export async function markRevoked(userId: string): Promise<void> {
  const client = serviceClient();
  await client
    .from('github_connections')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
  await client.schema('private').from('github_tokens').delete().eq('user_id', userId);
}
