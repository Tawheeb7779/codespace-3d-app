import type { MemberRole } from '@/types';

/**
 * Invitation tokens.
 *
 * The token is generated in the browser, hashed, and only the hash is sent to
 * the database — so the server never holds anything that could be replayed,
 * and a database dump discloses nothing. The raw token exists exactly once, in
 * the link handed to whoever created the invitation.
 *
 * That means the link cannot be recovered if it is lost. Reissuing is the
 * remedy, and it is the right one: a system that could show you the link again
 * is a system that stored the token.
 */

export interface PendingInvitation {
  id: string;
  projectId: string;
  email: string;
  role: MemberRole;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export function invitationState(
  invitation: PendingInvitation,
  now = Date.now(),
): InvitationState {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.revokedAt) return 'revoked';
  if (invitation.expiresAt <= now) return 'expired';
  return 'pending';
}

/** Only a pending invitation can still be redeemed. */
export function isRedeemable(invitation: PendingInvitation, now = Date.now()): boolean {
  return invitationState(invitation, now) === 'pending';
}

/**
 * 32 random bytes, hex encoded.
 *
 * `crypto.getRandomValues` rather than `Math.random`: this value is the only
 * thing standing between a stranger and membership of a private project, so it
 * has to be unguessable, not merely unlikely.
 */
export function createInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The hash the database stores. Must match the SQL side exactly. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Shape a token must have before it is worth sending anywhere. */
export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}

/**
 * The link an invitee opens.
 *
 * The token goes in the URL fragment, not the query string: a fragment is
 * never sent to a server, so the token stays out of access logs, proxies and
 * `Referer` headers on the way in.
 */
export function invitationLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite#${token}`;
}

/** Read a token back out of a link's fragment. */
export function tokenFromFragment(fragment: string): string | null {
  const raw = fragment.replace(/^#/, '').trim();
  return isValidToken(raw) ? raw : null;
}
