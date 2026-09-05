import { describe, expect, it } from 'vitest';
import {
  createInvitationToken,
  hashInvitationToken,
  invitationLink,
  invitationState,
  isRedeemable,
  isValidToken,
  tokenFromFragment,
  type PendingInvitation,
} from '@/lib/invitations';

/**
 * Invitation tokens.
 *
 * This token is the only thing between a stranger and a private project, so
 * the properties worth holding are: it is unguessable, only its hash is ever
 * transmitted, it travels in a URL fragment where no server can log it, and a
 * spent or expired one is recognised as such rather than merely looking old.
 */

const invitation = (patch: Partial<PendingInvitation> = {}): PendingInvitation => ({
  id: 'inv_1',
  projectId: 'prj_1',
  email: 'someone@test.dev',
  role: 'editor',
  invitedBy: 'user_1',
  createdAt: 1_000,
  expiresAt: 100_000,
  acceptedAt: null,
  revokedAt: null,
  ...patch,
});

describe('generating a token', () => {
  it('is 32 bytes of hex, matching what the database constraint accepts', () => {
    const token = createInvitationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidToken(token)).toBe(true);
  });

  /** Guessability is the whole risk; two tokens must never collide. */
  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createInvitationToken()));
    expect(tokens.size).toBe(200);
  });

  it('rejects anything that is not a token', () => {
    for (const bad of ['', 'nope', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65), null, 42, {}]) {
      expect(isValidToken(bad), String(bad)).toBe(false);
    }
  });
});

describe('hashing', () => {
  it('produces the sha-256 hex the schema constraint expects', async () => {
    const hash = await hashInvitationToken('a'.repeat(64));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable, so the same link always finds the same row', async () => {
    const token = createInvitationToken();
    expect(await hashInvitationToken(token)).toBe(await hashInvitationToken(token));
  });

  it('differs for different tokens', async () => {
    expect(await hashInvitationToken('a'.repeat(64))).not.toBe(
      await hashInvitationToken('b'.repeat(64)),
    );
  });

  /** The hash must not be the token: storing it must disclose nothing. */
  it('never returns the input', async () => {
    const token = createInvitationToken();
    expect(await hashInvitationToken(token)).not.toBe(token);
  });

  it('matches a known SHA-256 vector', async () => {
    // sha256("abc"), the standard test vector.
    expect(await hashInvitationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('the link', () => {
  /** A fragment is never sent to a server — no access log, no Referer. */
  it('puts the token in the fragment, not the query string', () => {
    const link = invitationLink('https://forge.example.com', 'a'.repeat(64));
    expect(link).toBe(`https://forge.example.com/invite#${'a'.repeat(64)}`);
    expect(new URL(link).search).toBe('');
    expect(new URL(link).hash).toContain('a'.repeat(64));
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(invitationLink('https://forge.example.com/', 'b'.repeat(64))).toContain(
      'forge.example.com/invite#',
    );
  });

  it('reads a token back out, and refuses a malformed one', () => {
    expect(tokenFromFragment(`#${'c'.repeat(64)}`)).toBe('c'.repeat(64));
    expect(tokenFromFragment('c'.repeat(64))).toBe('c'.repeat(64));
    for (const bad of ['', '#', '#nope', '#' + 'z'.repeat(64), '#../../etc']) {
      expect(tokenFromFragment(bad), bad).toBeNull();
    }
  });
});

describe('invitation state', () => {
  it('is pending while unused, unrevoked and unexpired', () => {
    expect(invitationState(invitation(), 50_000)).toBe('pending');
    expect(isRedeemable(invitation(), 50_000)).toBe(true);
  });

  it('reports acceptance ahead of everything else', () => {
    // Already used: that it has also expired since does not change the answer.
    expect(invitationState(invitation({ acceptedAt: 2_000 }), 500_000)).toBe('accepted');
    expect(isRedeemable(invitation({ acceptedAt: 2_000 }), 50_000)).toBe(false);
  });

  it('reports revocation', () => {
    expect(invitationState(invitation({ revokedAt: 2_000 }), 50_000)).toBe('revoked');
    expect(isRedeemable(invitation({ revokedAt: 2_000 }), 50_000)).toBe(false);
  });

  it('expires exactly at the boundary, not after it', () => {
    expect(invitationState(invitation(), 99_999)).toBe('pending');
    expect(invitationState(invitation(), 100_000)).toBe('expired');
    expect(isRedeemable(invitation(), 100_000)).toBe(false);
  });
});
