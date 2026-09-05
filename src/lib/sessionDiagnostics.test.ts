import { describe, expect, it } from 'vitest';
import { describeSession, readTokenClaims, summariseSession } from '@/lib/sessionDiagnostics';

/**
 * The claims PostgREST actually acts on.
 *
 * A live deployment refused an insert with 42501 while every database-side
 * check passed: the policy was permissive, scoped TO authenticated, tied to
 * `auth.uid()`, with no BEFORE INSERT trigger and correct grants. The client
 * reported that `owner_id` matched the session user — but it had taken
 * `owner_id` *from* the session, so that comparison was a variable against
 * itself and could never have failed.
 *
 * PostgREST takes the database role from the token's `role` claim and
 * `auth.uid()` from its `sub`. A token claiming any other role is refused by a
 * policy written TO authenticated, and the message is identical. These are the
 * independent measurement, and the point of them is that they can disagree.
 */

const HOST = 'awgdurlvfqxtdadpuzse.supabase.co';
const USER = '57246737-dfc3-48b1-9f27-6ec5157bc7fb';

/** A JWT-shaped string. The signature is never read, so it is a placeholder. */
function token(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.not-a-real-signature`;
}

const healthy = (over: Record<string, unknown> = {}) => ({
  user: { id: USER },
  access_token: token({
    iss: `https://${HOST}/auth/v1`,
    aud: 'authenticated',
    sub: USER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  }),
});

describe('reading the claims', () => {
  it('extracts exactly the five that matter', () => {
    const claims = readTokenClaims(healthy().access_token);
    expect(claims).toEqual({
      iss: `https://${HOST}/auth/v1`,
      aud: 'authenticated',
      sub: USER,
      role: 'authenticated',
      exp: expect.any(Number),
    });
  });

  it('returns null rather than throwing on anything unreadable', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!.c', undefined, null]) {
      expect(readTokenClaims(bad)).toBeNull();
    }
  });
});

describe('a healthy session', () => {
  it('agrees with itself and with the configured project', () => {
    const facts = describeSession(healthy(), HOST);
    expect(facts.subjectMatchesSession).toBe(true);
    expect(facts.roleIsAuthenticated).toBe(true);
    expect(facts.issuerMatchesConfig).toBe(true);
    expect(facts.expired).toBe(false);
    expect(summariseSession(facts)).toMatch(/consistent/i);
  });
});

describe('the ways a session can be wrong while looking right', () => {
  /** The cause the client could not previously see at all. */
  it('names a role claim that is not authenticated', () => {
    const facts = describeSession(healthy({ role: 'anon' }), HOST);
    expect(facts.roleIsAuthenticated).toBe(false);
    const summary = summariseSession(facts);
    expect(summary).toMatch(/claims role "anon"/);
    expect(summary).toMatch(/never applies/i);
  });

  it('names a missing role claim', () => {
    const facts = describeSession(healthy({ role: undefined }), HOST);
    expect(facts.roleIsAuthenticated).toBe(false);
    expect(summariseSession(facts)).toMatch(/\(none\)/);
  });

  it('names a token minted by a different project', () => {
    const facts = describeSession(healthy({ iss: 'https://other-project.supabase.co/auth/v1' }), HOST);
    expect(facts.issuerMatchesConfig).toBe(false);
    expect(summariseSession(facts)).toMatch(/issued by other-project\.supabase\.co/);
  });

  it('names a subject that is not the session user', () => {
    const facts = describeSession(healthy({ sub: '00000000-0000-0000-0000-000000000000' }), HOST);
    expect(facts.subjectMatchesSession).toBe(false);
    expect(summariseSession(facts)).toMatch(/not the session's user id/);
  });

  it('names an expired token', () => {
    const facts = describeSession(healthy({ exp: Math.floor(Date.now() / 1000) - 120 }), HOST);
    expect(facts.expired).toBe(true);
    expect(summariseSession(facts)).toMatch(/expired 1[0-9]{2}s ago/);
  });

  it('reports several faults at once rather than stopping at the first', () => {
    const summary = summariseSession(
      describeSession(healthy({ role: 'anon', iss: 'https://elsewhere.supabase.co/auth/v1' }), HOST),
    );
    expect(summary).toMatch(/role "anon"/);
    expect(summary).toMatch(/elsewhere\.supabase\.co/);
  });

  it('says so plainly when there is no session', () => {
    expect(summariseSession(describeSession(null, HOST))).toMatch(/no session/i);
  });
});

describe('what must never escape', () => {
  it('never emits the token, its signature, or a key', () => {
    const session = healthy();
    for (const facts of [
      describeSession(session, HOST),
      describeSession(healthy({ role: 'anon' }), HOST),
      describeSession(null, HOST),
    ]) {
      const summary = summariseSession(facts);
      expect(summary).not.toContain(session.access_token);
      expect(summary).not.toContain('not-a-real-signature');
      expect(summary).not.toMatch(/eyJ|apikey|bearer|service_role|refresh/i);
      expect(JSON.stringify(facts)).not.toContain(session.access_token);
    }
  });
});
