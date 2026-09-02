import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase is optional. When the two public env vars are absent the whole app
 * runs in Local Development Mode: projects live in localStorage, auth issues a
 * local session, and every Supabase-backed call short-circuits with a clear
 * error instead of throwing an opaque network failure.
 *
 * Only the anon (publishable) key belongs here. A service-role key must never
 * reach the browser — it bypasses row level security.
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

function looksLikeServiceRole(key: string): boolean {
  // A service-role JWT carries "role":"service_role" in its payload.
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role';
  } catch {
    return false;
  }
}

let configured = Boolean(url && anonKey);

if (configured && looksLikeServiceRole(anonKey)) {
  configured = false;
  // Refuse to boot with a service-role key rather than shipping one to users.
  console.error(
    '[forge] VITE_SUPABASE_ANON_KEY looks like a service-role key. Refusing to use it. ' +
      'Use the anon/publishable key; the service-role key must stay server side.',
  );
}

export const isSupabaseConfigured = configured;

export const supabase: SupabaseClient | null = configured
  ? createClient(url, anonKey, {
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
