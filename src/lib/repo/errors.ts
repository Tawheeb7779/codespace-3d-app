/**
 * Turning a PostgREST failure into something a person can act on.
 *
 * Every one of these arrives as the same shape — a code, a sentence written for
 * whoever wrote the SQL — and the application used to paste that sentence
 * straight into the UI. `new row violates row-level security policy for table
 * "projects"` tells a customer nothing, and guessing at a single cause is
 * worse: an earlier version of this file asserted the insert policy was
 * missing, which was wrong on a database where the policy is present.
 *
 * So this classifies, and where several causes share one code it says which
 * ones remain rather than picking one.
 */

/** The PostgREST/Postgres error shape the client actually receives. */
export interface DatabaseError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export type DatabaseFailure =
  | 'not-authorized'
  | 'session'
  | 'network'
  | 'schema'
  | 'conflict'
  | 'missing-reference'
  | 'invalid'
  | 'unknown';

/**
 * Which kind of failure this is.
 *
 * Codes come from Postgres (five characters) and PostgREST (`PGRST…`). Anything
 * unrecognised stays `unknown` rather than being forced into a category — a
 * wrong explanation costs more than no explanation.
 */
export function classifyDatabaseError(error: DatabaseError | null): DatabaseFailure {
  const code = error?.code ?? '';
  if (code === '42501') return 'not-authorized';
  if (code === 'PGRST301' || code === '42P02' || /jwt|token/i.test(error?.message ?? '')) {
    return 'session';
  }
  // A request that never reached Postgres has no SQLSTATE at all.
  if (!code && /fetch|network|load failed/i.test(error?.message ?? '')) return 'network';
  if (code === '42P01' || code === '42703' || code === 'PGRST204' || code === 'PGRST205') {
    return 'schema';
  }
  if (code === '23505') return 'conflict';
  if (code === '23503') return 'missing-reference';
  if (code === '23502' || code === '23514' || code === '22P02') return 'invalid';
  return 'unknown';
}

/** What the client knew about its own identity when the write was refused. */
export interface WriteIdentity {
  /** The id the live session reports. Never a token — a uuid. */
  sessionUserId: string;
  /** The id the row was to be filed under. */
  rowOwnerId: string;
  /** Host only. It is in every request the browser already makes. */
  host: string;
}

/**
 * State what the client knows about a row-policy refusal.
 *
 * Postgres names the policy in the message when a RESTRICTIVE one is the
 * blocker; an unnamed refusal means no permissive policy admitted the row.
 * Verified against a real database: with a correct `(owner_id = auth.uid())`
 * policy in place, four different situations still produce that unnamed
 * sentence — the owner not matching the caller, no subject in the session, the
 * policy scoped to a role other than the caller's, and a BEFORE INSERT trigger
 * rewriting the owner.
 *
 * Only the first two are visible from here, so only those are named. Which of
 * the rest applies is a question for the database, and `identityProbe` asks it.
 */
export function describeRowPolicyRefusal(identity: WriteIdentity): string {
  const { sessionUserId, rowOwnerId, host } = identity;

  if (!sessionUserId) {
    return 'You are not signed in to the database, so it refused the row. Sign in again and retry.';
  }
  if (rowOwnerId && rowOwnerId !== sessionUserId) {
    return (
      'The row was about to be filed under a different account than the one signed in ' +
      `(${rowOwnerId} rather than ${sessionUserId}). Sign out and back in, then retry.`
    );
  }
  // The facts, and nothing more: what the row claimed and which project refused
  // it. What to do about it comes from the identity probe, which asks the
  // database directly rather than reasoning from here.
  return `The row belonged to the signed-in account (${sessionUserId}) and ${host} still refused it.`;
}

/** A sentence for the failures that are not about authorization. */
export function describeDatabaseError(error: DatabaseError | null): string {
  switch (classifyDatabaseError(error)) {
    case 'session':
      return 'Your session is no longer valid. Sign in again and retry.';
    case 'network':
      return 'The database could not be reached. Check your network connection.';
    case 'schema':
      return (
        'The database is missing something this version of Forge expects. ' +
        'Apply the migrations in supabase/migrations to this project.'
      );
    case 'conflict':
      return 'That already exists.';
    case 'missing-reference':
      return (
        'A record this depends on is missing. If you have just signed up, your profile ' +
        'row may not have been created — check the on_auth_user_created trigger.'
      );
    case 'invalid':
      return 'The database rejected the values sent.';
    default:
      return '';
  }
}
