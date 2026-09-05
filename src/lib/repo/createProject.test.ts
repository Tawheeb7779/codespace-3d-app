import { describe, expect, it } from 'vitest';
import {
  classifyDatabaseError,
  describeDatabaseError,
  describeRowPolicyRefusal,
} from '@/lib/repo/errors';

/**
 * Reporting a database refusal truthfully.
 *
 * Creating a project in Cloud Mode failed with 42501, "new row violates
 * row-level security policy for table projects", and an earlier version of
 * this code answered by asserting the insert policy was missing. On the
 * deployment in question the policy is present and correct, so that assertion
 * was simply wrong — and being confidently wrong sent the operator to fix
 * something that was not broken.
 *
 * Verified against a real PostgreSQL with `(owner_id = auth.uid())` in place:
 * four different situations still produce that same unnamed sentence — the row
 * owner not matching the caller, a session with no subject, the policy scoped
 * to a role other than the caller's, and a BEFORE INSERT trigger rewriting
 * owner_id. A RESTRICTIVE policy is the one cause that reads differently:
 * Postgres names the offending policy, so an unnamed refusal excludes it.
 *
 * The client can settle the first two from what it holds. It must not pick
 * between the rest.
 */

const HOST = 'example-project.supabase.co';
const ME = '11111111-1111-1111-1111-111111111111';
const SOMEONE_ELSE = '22222222-2222-2222-2222-222222222222';

describe('classifying what came back', () => {
  it.each([
    ['42501', 'not-authorized'],
    ['PGRST301', 'session'],
    ['42P01', 'schema'],
    ['42703', 'schema'],
    ['PGRST204', 'schema'],
    ['23505', 'conflict'],
    ['23503', 'missing-reference'],
    ['23502', 'invalid'],
    ['23514', 'invalid'],
    ['22P02', 'invalid'],
  ])('reads %s as %s', (code, expected) => {
    expect(classifyDatabaseError({ code })).toBe(expected);
  });

  it('recognises a request that never reached Postgres', () => {
    expect(classifyDatabaseError({ message: 'TypeError: Failed to fetch' })).toBe('network');
  });

  /** An unrecognised code must not be forced into a category. */
  it('leaves anything it does not recognise unknown', () => {
    expect(classifyDatabaseError({ code: '40001' })).toBe('unknown');
    expect(classifyDatabaseError(null)).toBe('unknown');
  });
});

describe('a row-policy refusal', () => {
  it('never claims the policy is missing', () => {
    const message = describeRowPolicyRefusal({
      sessionUserId: ME,
      rowOwnerId: ME,
      host: HOST,
    });
    expect(message).not.toMatch(/missing its insert policy|policy is missing|no insert policy/i);
  });

  /**
   * Naming what to check is the identity probe's job, because only the
   * database can say whether the session was honoured. This message states
   * what the client itself observed and stops there.
   */
  it('states the facts and leaves the verdict to the probe', () => {
    const message = describeRowPolicyRefusal({ sessionUserId: ME, rowOwnerId: ME, host: HOST });
    expect(message).toMatch(/belonged to the signed-in account/i);
    expect(message).toMatch(/still refused it/i);
    expect(message).not.toMatch(/BEFORE INSERT trigger/i);
  });

  it('reports the identity it actually used, and the project', () => {
    const message = describeRowPolicyRefusal({ sessionUserId: ME, rowOwnerId: ME, host: HOST });
    expect(message).toContain(ME);
    expect(message).toContain(HOST);
  });

  it('names the mismatch when the row was headed elsewhere', () => {
    const message = describeRowPolicyRefusal({
      sessionUserId: ME,
      rowOwnerId: SOMEONE_ELSE,
      host: HOST,
    });
    expect(message).toContain(SOMEONE_ELSE);
    expect(message).toMatch(/different account/i);
    expect(message).not.toMatch(/BEFORE INSERT trigger/i);
  });

  it('says so plainly when there is no session at all', () => {
    const message = describeRowPolicyRefusal({ sessionUserId: '', rowOwnerId: '', host: HOST });
    expect(message).toMatch(/not signed in/i);
    expect(message).not.toMatch(/trigger|TO authenticated/i);
  });

  it('carries no token, key or secret', () => {
    for (const identity of [
      { sessionUserId: ME, rowOwnerId: ME, host: HOST },
      { sessionUserId: '', rowOwnerId: '', host: HOST },
    ]) {
      expect(describeRowPolicyRefusal(identity)).not.toMatch(/eyJ|apikey|bearer|service_role/i);
    }
  });
});

describe('the other failures each get their own sentence', () => {
  it('points at the migrations only for a genuine schema gap', () => {
    expect(describeDatabaseError({ code: '42P01' })).toMatch(/supabase\/migrations/);
    expect(describeDatabaseError({ code: '42501' })).not.toMatch(/supabase\/migrations/);
  });

  it('distinguishes a session failure from an authorization one', () => {
    expect(describeDatabaseError({ code: 'PGRST301' })).toMatch(/sign in again/i);
  });

  it('names the profile trigger for a missing related record', () => {
    expect(describeDatabaseError({ code: '23503' })).toMatch(/on_auth_user_created/);
  });

  it('says nothing rather than guessing at an unknown code', () => {
    expect(describeDatabaseError({ code: '40001' })).toBe('');
  });
});
