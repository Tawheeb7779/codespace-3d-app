import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which side of the wire refused a row.
 *
 * When `owner_id` is taken from the live session and the database still says
 * `new row violates row-level security policy`, exactly one of two things is
 * true, and the difference decides who fixes it:
 *
 *   - PostgREST did not accept the session, so `auth.uid()` is not the id the
 *     browser believes it is. Nothing about the `projects` table is wrong.
 *   - PostgREST did accept it, `auth.uid()` is that id, and the refusal is
 *     something about `projects` itself — the insert policy scoped to another
 *     role, a second policy, or a trigger rewriting the row before the check.
 *
 * The probe settles it with a read the caller is already entitled to make:
 * their own `profiles` row, which `profiles_select_self_or_shared` admits on
 * `id = auth.uid()`. It writes nothing, needs no migration, grants nothing,
 * and touches no data belonging to anyone else.
 */

export type IdentityVerdict =
  | 'session-honoured'
  | 'running-as-anon'
  | 'identity-mismatch'
  | 'inconclusive';

export interface IdentityFinding {
  verdict: IdentityVerdict;
  /** One sentence naming what to look at next. Never contains a credential. */
  detail: string;
}

/** `anon` holds no privilege in this schema, so this is what it sounds like. */
function deniedOutright(message: string): boolean {
  return /permission denied for (schema|table|relation)/i.test(message);
}

/**
 * Ask the database who it thinks the caller is.
 *
 * `sessionUserId` is the id the browser holds. The row comes back only when
 * `auth.uid()` equals it, so the presence of that row *is* the answer.
 */
export async function probeIdentity(
  client: Pick<SupabaseClient, 'from'>,
  sessionUserId: string,
): Promise<IdentityFinding> {
  try {
    const { data, error } = await client
      .from('profiles')
      .select('id')
      .eq('id', sessionUserId)
      .maybeSingle();

    if (error) {
      if (deniedOutright(error.message ?? '')) {
        return {
          verdict: 'running-as-anon',
          detail:
            'The database is treating this browser as an anonymous visitor, so auth.uid() is null ' +
            'and every row policy fails. The session token is not being accepted — it may be ' +
            'expired, or issued by a different Supabase project than the one configured. ' +
            'Sign out and sign in again.',
        };
      }
      return {
        verdict: 'inconclusive',
        detail: `The identity check itself failed: ${error.message}`,
      };
    }

    if (data) {
      return {
        verdict: 'session-honoured',
        detail:
          'The database accepts this session and agrees on the account, so auth.uid() is correct ' +
          'and the refusal is specific to the projects table. Check that projects_insert_owner ' +
          'applies TO authenticated, that no other policy on projects also governs INSERT, and ' +
          'that no BEFORE INSERT trigger rewrites owner_id. ' +
          'docs/rls-troubleshooting.sql reports all three.',
      };
    }

    return {
      verdict: 'identity-mismatch',
      detail:
        'The database returned no profile for this account. Either auth.uid() is not the id this ' +
        'browser holds, or the profile row was never created for it — check the ' +
        'on_auth_user_created trigger on auth.users.',
    };
  } catch (caught) {
    return {
      verdict: 'inconclusive',
      detail: `The identity check could not run: ${(caught as Error).message}`,
    };
  }
}
