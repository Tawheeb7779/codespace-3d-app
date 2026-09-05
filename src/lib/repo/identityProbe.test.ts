import { describe, expect, it, vi } from 'vitest';
import { probeIdentity } from '@/lib/repo/identityProbe';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which side refused the row.
 *
 * A live deployment reported `new row violates row-level security policy for
 * table "projects"` while the client was sending the session's own user id as
 * `owner_id`. Both remaining explanations are consistent with that one
 * sentence, and they belong to different people:
 *
 *   - PostgREST did not accept the session, so `auth.uid()` is not the id the
 *     browser holds — a session problem, nothing wrong with the table.
 *   - PostgREST accepted it, so the refusal is something about `projects` —
 *     the policy scoped to another role, a second policy, or a trigger.
 *
 * The probe reads the caller's own `profiles` row, which
 * `profiles_select_self_or_shared` admits on `id = auth.uid()`. Its presence
 * is the answer. These pin each outcome, including that it never leaks a
 * credential while reporting one.
 */

const ME = '57246737-dfc3-48b1-9f27-6ec5157bc7fb';

/** A client whose single `.maybeSingle()` resolves to whatever is given. */
function clientReturning(result: { data?: unknown; error?: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as Pick<SupabaseClient, 'from'>, from, select, eq };
}

describe('the database accepts the session', () => {
  it('reports that the refusal is specific to the projects table', async () => {
    const { client } = clientReturning({ data: { id: ME }, error: null });
    const finding = await probeIdentity(client, ME);

    expect(finding.verdict).toBe('session-honoured');
    expect(finding.detail).toMatch(/auth\.uid\(\) is correct/i);
    expect(finding.detail).toMatch(/TO authenticated/);
    expect(finding.detail).toMatch(/BEFORE INSERT trigger/i);
  });

  it('asks only for the caller\'s own row', async () => {
    const { client, from, eq } = clientReturning({ data: { id: ME }, error: null });
    await probeIdentity(client, ME);

    expect(from).toHaveBeenCalledWith('profiles');
    expect(eq).toHaveBeenCalledWith('id', ME);
  });
});

describe('the database is treating the caller as anonymous', () => {
  /** `anon` holds no privilege in this schema, so this is how it surfaces. */
  it.each([
    'permission denied for schema public',
    'permission denied for table profiles',
    'permission denied for relation profiles',
  ])('recognises %s', async (message) => {
    const { client } = clientReturning({ data: null, error: { message } });
    const finding = await probeIdentity(client, ME);

    expect(finding.verdict).toBe('running-as-anon');
    expect(finding.detail).toMatch(/anonymous visitor/i);
    expect(finding.detail).toMatch(/sign out and sign in again/i);
    // It must not send anyone to the projects table for a session fault.
    expect(finding.detail).not.toMatch(/BEFORE INSERT trigger/i);
  });
});

describe('the session and the database disagree on who this is', () => {
  it('names both possibilities without choosing', async () => {
    const { client } = clientReturning({ data: null, error: null });
    const finding = await probeIdentity(client, ME);

    expect(finding.verdict).toBe('identity-mismatch');
    expect(finding.detail).toMatch(/auth\.uid\(\) is not the id/i);
    expect(finding.detail).toMatch(/on_auth_user_created/);
  });
});

describe('the probe itself is not allowed to make things worse', () => {
  it('stays inconclusive rather than guessing when it cannot run', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'connection reset' } });
    expect((await probeIdentity(client, ME)).verdict).toBe('inconclusive');
  });

  it('survives a client that throws', async () => {
    const from = vi.fn(() => {
      throw new Error('boom');
    });
    const finding = await probeIdentity({ from } as unknown as Pick<SupabaseClient, 'from'>, ME);
    expect(finding.verdict).toBe('inconclusive');
    expect(finding.detail).toContain('boom');
  });

  it('never puts a token, key or secret in what it reports', async () => {
    for (const result of [
      { data: { id: ME }, error: null },
      { data: null, error: { message: 'permission denied for schema public' } },
      { data: null, error: null },
    ]) {
      const { client } = clientReturning(result);
      const { detail } = await probeIdentity(client, ME);
      expect(detail).not.toMatch(/eyJ|apikey|bearer|service_role|access_token|refresh/i);
    }
  });
});
