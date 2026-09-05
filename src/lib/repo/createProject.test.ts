import { describe, expect, it } from 'vitest';
import { createProjectContext } from '@/lib/repo/supabaseRepository';

/**
 * Telling apart the two reasons a project insert is refused.
 *
 * Creating a project in Cloud Mode failed with
 *
 *   Could not create project: new row violates row-level security policy for
 *   table "projects" (42501)
 *
 * Postgres words that refusal identically whether the client asked to file the
 * row under a different account or the deployment is missing the policy that
 * permits the ordinary case. Confirmed against a real database: with the
 * repository's migrations applied the insert succeeds, and it fails with that
 * exact sentence both when `owner_id` is somebody else and when
 * `projects_insert_owner` has been dropped.
 *
 * The two need opposite responses — sign in again, or apply the migrations —
 * so the message has to say which one this is.
 */

const denied = { code: '42501' };
const ME = '11111111-1111-1111-1111-111111111111';
const SOMEONE_ELSE = '22222222-2222-2222-2222-222222222222';

describe('a refusal that is really a stale session', () => {
  it('says the row was headed for another account', () => {
    const message = createProjectContext(denied, ME, SOMEONE_ELSE);
    expect(message).toMatch(/different account/i);
    expect(message).toMatch(/sign out and back in/i);
  });

  it('does not send the operator to the migrations for it', () => {
    expect(createProjectContext(denied, ME, SOMEONE_ELSE)).not.toMatch(/migrations/i);
  });
});

describe('a refusal of a row that genuinely belongs to the caller', () => {
  it('names the missing policy and where to fix it', () => {
    const message = createProjectContext(denied, ME, ME);
    expect(message).toMatch(/insert policy/i);
    expect(message).toMatch(/supabase\/migrations/);
  });

  it('does not blame the session, which is fine', () => {
    expect(createProjectContext(denied, ME, ME)).not.toMatch(/sign out|expired/i);
  });

  /** The store may not have filled an owner in; the session still decides. */
  it('treats an absent requested owner as the ordinary case', () => {
    expect(createProjectContext(denied, ME, '')).toMatch(/insert policy/i);
  });
});

describe('everything that is not a policy refusal', () => {
  it.each([
    ['a foreign key violation', '23503'],
    ['a check constraint', '23514'],
    ['a unique violation', '23505'],
    ['no code at all', undefined],
  ])('keeps the plain context for %s', (_label, code) => {
    expect(createProjectContext({ code }, ME, ME)).toBe('Could not create project');
  });

  it('keeps the plain context when there is no error object', () => {
    expect(createProjectContext(null, ME, ME)).toBe('Could not create project');
  });
});
