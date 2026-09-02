import { describe, expect, it } from 'vitest';
import { resolveSupabaseConfig } from '@/lib/supabase';

/**
 * Configuration detection.
 *
 * Getting this wrong has two failure modes with opposite costs: refusing a
 * valid configuration strands a deployment in Local Development Mode, while
 * accepting a broken one puts the app in a "Cloud" state where every request
 * fails and the local fallback never engages.
 */

/** A JWT-shaped token whose payload names a role. Not a real key. */
const jwtWithRole = (role: string) => {
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.signature`;
};

const ANON = jwtWithRole('anon');

describe('resolveSupabaseConfig', () => {
  it('accepts a well-formed project URL and anon key', () => {
    const config = resolveSupabaseConfig('https://abcdefghijklm.supabase.co', ANON);
    expect(config.ok).toBe(true);
    expect(config.reason).toBe('configured');
  });

  it('trims surrounding whitespace, which a copy-paste often carries', () => {
    const config = resolveSupabaseConfig('  https://x.supabase.co  ', `  ${ANON}  `);
    expect(config.ok).toBe(true);
    expect(config.url).toBe('https://x.supabase.co');
    expect(config.anonKey).toBe(ANON);
  });

  it('falls back to local mode when nothing is set', () => {
    expect(resolveSupabaseConfig(undefined, undefined)).toMatchObject({
      ok: false,
      reason: 'missing-url',
    });
    expect(resolveSupabaseConfig('', '')).toMatchObject({ ok: false, reason: 'missing-url' });
  });

  it('names which of the two is missing', () => {
    expect(resolveSupabaseConfig('https://x.supabase.co', '')).toMatchObject({
      ok: false,
      reason: 'missing-key',
    });
    expect(resolveSupabaseConfig('', ANON)).toMatchObject({ ok: false, reason: 'missing-url' });
  });

  /**
   * The case that used to slip through: a URL that is present but wrong built
   * a client anyway, so the UI reported Cloud mode and every call failed.
   */
  it('refuses a malformed URL rather than reporting a broken cloud mode', () => {
    for (const bad of ['not-a-url', 'abcdefg.supabase.co', 'https://', '://x']) {
      const config = resolveSupabaseConfig(bad, ANON);
      expect(config.ok, bad).toBe(false);
      expect(config.reason, bad).toBe('invalid-url');
    }
  });

  it('refuses a plaintext URL, which would put the anon key on the wire', () => {
    expect(resolveSupabaseConfig('http://myproject.supabase.co', ANON)).toMatchObject({
      ok: false,
      reason: 'invalid-url',
    });
  });

  it('still allows http on localhost, for `supabase start`', () => {
    expect(resolveSupabaseConfig('http://localhost:54321', ANON).ok).toBe(true);
    expect(resolveSupabaseConfig('http://127.0.0.1:54321', ANON).ok).toBe(true);
  });

  it('refuses a service-role key outright', () => {
    const config = resolveSupabaseConfig('https://x.supabase.co', jwtWithRole('service_role'));
    expect(config.ok).toBe(false);
    expect(config.reason).toBe('service-role-key');
    expect(config.detail).toMatch(/row level security/i);
  });

  it('does not mistake an opaque non-JWT key for a service-role key', () => {
    // Newer Supabase publishable keys are not JWTs at all.
    expect(resolveSupabaseConfig('https://x.supabase.co', 'sb_publishable_abc123').ok).toBe(true);
  });

  it('explains every rejection, so the mode is never unexplained', () => {
    for (const config of [
      resolveSupabaseConfig(undefined, undefined),
      resolveSupabaseConfig('https://x.supabase.co', ''),
      resolveSupabaseConfig('nope', ANON),
      resolveSupabaseConfig('https://x.supabase.co', jwtWithRole('service_role')),
    ]) {
      expect(config.detail.length).toBeGreaterThan(10);
    }
  });

  /** The anon key is public by design; the service-role key never is. */
  it('never reports the key back in the detail message', () => {
    const secret = jwtWithRole('service_role');
    expect(resolveSupabaseConfig('https://x.supabase.co', secret).detail).not.toContain(secret);
  });
});
