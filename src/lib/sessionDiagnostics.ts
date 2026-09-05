/**
 * What the access token actually claims.
 *
 * PostgREST does not take the caller's database role from the session object
 * the browser holds; it takes it from the `role` claim inside the JWT, and
 * `auth.uid()` from the `sub` claim. A policy written `TO authenticated` never
 * applies to a request whose token claims a different role, and the refusal is
 * the same sentence as every other row-policy failure:
 *
 *   new row violates row-level security policy for table "projects"  (42501)
 *
 * The application reports `session.user.id` and calls it a match, but it sends
 * that same value as `owner_id` — comparing a variable with itself proves only
 * that the client is consistent, never that the server agrees. These claims are
 * the independent measurement.
 *
 * The token is read, never returned and never logged. Only `iss`, `aud`, `sub`,
 * `role` and `exp` leave this module; the signature and everything else stay
 * inside it. Reading is deliberately unverified — the browser cannot verify a
 * signature it has no key for, and does not need to: the claims are used to
 * explain a failure, never to grant anything.
 */

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  role: string;
  /** Seconds since the epoch, as the token states it. */
  exp: number;
}

export interface SessionFacts {
  hasSession: boolean;
  /** The id the session object reports. */
  sessionUserId: string;
  claims: TokenClaims | null;
  /** `sub` and the session's user id must agree; they come from the same token. */
  subjectMatchesSession: boolean;
  /** The role PostgREST will assume. Anything but `authenticated` is the bug. */
  roleIsAuthenticated: boolean;
  /** The project that minted the token, compared with the one configured. */
  issuerHost: string;
  issuerMatchesConfig: boolean;
  expired: boolean;
  secondsUntilExpiry: number;
}

/** Decode one base64url segment. Throws for anything that is not one. */
function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return JSON.parse(json) as unknown;
}

/**
 * Read the claims out of a JWT.
 *
 * Returns null for anything unreadable rather than throwing: a diagnostic that
 * fails is not allowed to replace the failure it was called to explain.
 */
export function readTokenClaims(accessToken: string | undefined | null): TokenClaims | null {
  if (!accessToken) return null;
  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = decodeSegment(segments[1]) as Record<string, unknown>;
    return {
      iss: typeof payload.iss === 'string' ? payload.iss : '',
      aud: typeof payload.aud === 'string' ? payload.aud : '',
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      role: typeof payload.role === 'string' ? payload.role : '',
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Everything safe that can be said about the current session.
 *
 * `configuredHost` is the project the client is pointed at, so a token minted
 * by a different project shows up as a mismatch rather than as a mystery.
 */
export function describeSession(
  session: { user?: { id?: string }; access_token?: string } | null,
  configuredHost: string,
  now = Date.now(),
): SessionFacts {
  const claims = readTokenClaims(session?.access_token);
  const sessionUserId = session?.user?.id ?? '';
  const issuerHost = claims ? hostOf(claims.iss) : '';
  const secondsUntilExpiry = claims?.exp ? Math.round(claims.exp - now / 1000) : 0;

  return {
    hasSession: Boolean(session),
    sessionUserId,
    claims,
    subjectMatchesSession: Boolean(claims && sessionUserId && claims.sub === sessionUserId),
    roleIsAuthenticated: claims?.role === 'authenticated',
    issuerHost,
    issuerMatchesConfig: Boolean(issuerHost && issuerHost === configuredHost),
    expired: Boolean(claims?.exp && claims.exp * 1000 <= now),
    secondsUntilExpiry,
  };
}

/**
 * One line naming whichever of these is wrong, or confirming they are not.
 *
 * Deliberately short: it is appended to an error a person is already reading.
 */
export function summariseSession(facts: SessionFacts): string {
  if (!facts.hasSession) return 'No session is present in this browser.';
  if (!facts.claims) return 'The session token could not be read, so its claims are unknown.';

  const wrong: string[] = [];
  if (!facts.roleIsAuthenticated) {
    wrong.push(
      `the token claims role "${facts.claims.role || '(none)'}", not "authenticated" — ` +
        'PostgREST assumes that role, so a policy granted TO authenticated never applies',
    );
  }
  if (!facts.issuerMatchesConfig) {
    wrong.push(
      `the token was issued by ${facts.issuerHost || '(unreadable)'} but this app is ` +
        'configured for a different project',
    );
  }
  if (!facts.subjectMatchesSession) {
    wrong.push(
      `the token's subject (${facts.claims.sub || '(none)'}) is not the session's user id`,
    );
  }
  if (facts.expired) {
    wrong.push(`the token expired ${Math.abs(facts.secondsUntilExpiry)}s ago`);
  }

  if (wrong.length) return `Session claims: ${wrong.join('; ')}.`;
  return (
    `Session claims are consistent: sub=${facts.claims.sub}, role=${facts.claims.role}, ` +
    `aud=${facts.claims.aud || '(none)'}, iss host=${facts.issuerHost}, ` +
    `expires in ${facts.secondsUntilExpiry}s.`
  );
}
