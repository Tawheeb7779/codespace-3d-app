import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase is optional. When the two public env vars are absent the whole app
 * runs in Local Development Mode: projects live in IndexedDB, auth issues a
 * local session, and every Supabase-backed call short-circuits with a clear
 * error instead of throwing an opaque network failure.
 *
 * Only the anon (publishable) key belongs here. A service-role key must never
 * reach the browser — it bypasses row level security.
 */

export type SupabaseConfigReason =
  | 'configured'
  | 'missing-url'
  | 'missing-key'
  | 'invalid-url'
  | 'service-role-key';

export interface SupabaseConfig {
  ok: boolean;
  reason: SupabaseConfigReason;
  url: string;
  anonKey: string;
  /** Operator-facing explanation, logged once at boot when not configured. */
  detail: string;
}

/** A service-role JWT carries `"role":"service_role"` in its payload. */
function looksLikeServiceRole(key: string): boolean {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

/**
 * Decide whether Supabase is usable, from the two values alone.
 *
 * Pure and exported so every branch is testable — the module-level constants
 * below are read once at import time and cannot be varied from a test.
 *
 * The URL is shape-checked rather than merely present. A typo'd or
 * `http://`-scheme URL used to produce a client that looked configured and
 * then failed every request at runtime: the UI claimed Cloud mode and the
 * local fallback never engaged, which is the worst of both. A malformed URL
 * now degrades to Local Development Mode with a named reason.
 */
export function resolveSupabaseConfig(
  rawUrl: string | undefined,
  rawKey: string | undefined,
): SupabaseConfig {
  const url = rawUrl?.trim() ?? '';
  const anonKey = rawKey?.trim() ?? '';
  const base = { url, anonKey };

  if (!url) {
    return {
      ...base,
      ok: false,
      reason: 'missing-url',
      detail: 'VITE_SUPABASE_URL is not set.',
    };
  }
  if (!anonKey) {
    return {
      ...base,
      ok: false,
      reason: 'missing-key',
      detail: 'VITE_SUPABASE_ANON_KEY is not set.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ...base,
      ok: false,
      reason: 'invalid-url',
      detail: `VITE_SUPABASE_URL is not a valid URL: ${url.slice(0, 80)}`,
    };
  }
  // https only: the anon key travels on every request, and a plaintext
  // scheme would put it on the wire. localhost is allowed for `supabase start`.
  const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhost)) {
    return {
      ...base,
      ok: false,
      reason: 'invalid-url',
      detail: `VITE_SUPABASE_URL must use https (or http on localhost): ${url.slice(0, 80)}`,
    };
  }

  if (looksLikeServiceRole(anonKey)) {
    return {
      ...base,
      ok: false,
      reason: 'service-role-key',
      detail:
        'VITE_SUPABASE_ANON_KEY looks like a service-role key. Refusing to use it — it bypasses ' +
        'row level security and anything prefixed VITE_ ships to every visitor. Use the anon key.',
    };
  }

  return { ...base, ok: true, reason: 'configured', detail: 'Supabase is configured.' };
}

const config = resolveSupabaseConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

if (!config.ok && config.reason === 'service-role-key') {
  // A misconfiguration with security consequences deserves an error, not a hint.
  console.error(`[forge] ${config.detail}`);
} else if (!config.ok && config.reason === 'invalid-url') {
  console.error(`[forge] ${config.detail} Falling back to Local Development Mode.`);
}

export const isSupabaseConfigured = config.ok;
/** Why Supabase is unavailable, for the UI to explain the mode accurately. */
export const supabaseConfigReason = config.reason;
export const supabaseConfigDetail = config.detail;

export const supabase: SupabaseClient | null = config.ok
  ? createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;

export class SupabaseUnavailableError extends Error {
  constructor() {
    super(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud sync.',
    );
    this.name = 'SupabaseUnavailableError';
  }
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new SupabaseUnavailableError();
  return supabase;
}
