import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authErrorMessage, useAuthStore } from '@/stores/authStore';

/**
 * What the user is told when signing in fails.
 *
 * A real Supabase project that the browser cannot reach used to surface the
 * raw rejection from `fetch`: the alert read "Failed to fetch". That is
 * useless to a customer and, sitting under a password field, reads like the
 * password was rejected — which sends people to reset a password that was
 * never wrong.
 *
 * Everything Supabase itself answers with is already written for a person, so
 * only the unreachable case is rewritten. These pin both halves of that.
 */

/** How `fetch` rejects, per engine, when the request never completes. */
const unreachable = [
  ['Chrome / Edge', new TypeError('Failed to fetch')],
  ['Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
  ['Safari', new TypeError('Load failed')],
  ['Safari, connection dropped', new TypeError('The network connection was lost.')],
  ['undici', new TypeError('fetch failed')],
] as const;

describe('a Supabase project the browser cannot reach', () => {
  it.each(unreachable)('explains the failure instead of echoing %s', (_engine, error) => {
    const message = authErrorMessage(error);
    expect(message).toContain('Could not reach the authentication service');
    expect(message).toMatch(/network connection/i);
    expect(message).toMatch(/Supabase URL/i);
  });

  it('never implies the password was wrong', () => {
    for (const [, error] of unreachable) {
      expect(authErrorMessage(error)).not.toMatch(/password|credential|incorrect|invalid login/i);
    }
  });

  it('does not leave the raw fetch wording in front of the user', () => {
    expect(authErrorMessage(new TypeError('Failed to fetch'))).not.toBe('Failed to fetch');
  });

  /** supabase-js wraps some of these before they reach the caller. */
  it('recognises the shapes supabase-js reports for an unanswered request', () => {
    const wrapped = Object.assign(new Error('request failed'), {
      name: 'AuthRetryableFetchError',
    });
    expect(authErrorMessage(wrapped)).toContain('Could not reach the authentication service');

    const noStatus = Object.assign(new Error('network'), { status: 0 });
    expect(authErrorMessage(noStatus)).toContain('Could not reach the authentication service');
  });

  it('names no secret, no token and no key', () => {
    const message = authErrorMessage(new TypeError('Failed to fetch'));
    expect(message).not.toMatch(/eyJ|apikey|anon[_ -]?key|bearer|token/i);
  });
});

describe('everything Supabase actually answers is passed through', () => {
  it.each([
    'Invalid login credentials',
    'Email not confirmed',
    'User already registered',
    'Email rate limit exceeded',
    'For security purposes, you can only request this after 51 seconds.',
  ])('keeps %s exactly as Supabase worded it', (text) => {
    expect(authErrorMessage(new Error(text))).toBe(text);
  });

  /**
   * A genuine bug is a `TypeError` too. Dressing one up as a connectivity
   * problem would hide it from whoever has to fix it.
   */
  it('does not mistake a programming fault for a network failure', () => {
    const bug = new TypeError('undefined is not a function');
    expect(authErrorMessage(bug)).toBe('undefined is not a function');
  });

  it('still handles a non-Error rejection', () => {
    expect(authErrorMessage('something went wrong')).toBe('something went wrong');
  });
});

describe('the message reaches the store, and the store does not pretend otherwise', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, status: 'anonymous', error: null, busy: false });
  });

  it('records the readable message and stays signed out', async () => {
    const client = {
      auth: {
        signInWithPassword: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      },
    };
    const supabase = await import('@/lib/supabase');
    const spy = vi.spyOn(supabase, 'supabase', 'get').mockReturnValue(
      client as unknown as (typeof supabase)['supabase'],
    );

    // The store reads the module binding at call time, so re-import the store
    // behaviour through its public surface.
    const { useAuthStore: store } = await import('@/stores/authStore');
    await store.getState().signIn('someone@example.com', 'a-long-enough-password').catch(() => {});

    const state = store.getState();
    // The readable message is what the sign-in form renders.
    expect(state.error).toContain('Could not reach the authentication service');
    expect(state.error).not.toContain('Failed to fetch');
    expect(state.status).not.toBe('authenticated');
    expect(state.user).toBeNull();
    // A transport failure must never end up looking like a session, and must
    // not silently become a local account either.
    expect(state.busy).toBe(false);
    expect(client.auth.signInWithPassword).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

/**
 * The production report was: the owner signs in, a second person cannot.
 *
 * Every plausible cause of that asymmetry lives in remote configuration rather
 * than in this repository — email confirmation required with no working SMTP,
 * sign-ups disabled, a Google OAuth consent screen still in test mode with only
 * the owner added, a redirect URL allowlist missing the production origin. This
 * code cannot fix any of them.
 *
 * What it can do is not hide which one it is. Supabase's own wording is the
 * only thing that distinguishes "Email not confirmed" from "Invalid login
 * credentials" from "Signups not allowed", and an app that replaces all three
 * with "Sign-in failed" turns a five-minute dashboard fix into an
 * unreproducible bug report. So these assert the message survives.
 */
describe('the message a second user would actually see', () => {
  it.each([
    'Email not confirmed',
    'Invalid login credentials',
    'Signups not allowed for this instance',
    'Email link is invalid or has expired',
    'User already registered',
  ])('passes %s through verbatim', (message) => {
    expect(authErrorMessage(new Error(message))).toContain(message);
  });

  /**
   * The one case that is deliberately replaced: an unreachable host produces a
   * browser-specific string ("Failed to fetch", "Load failed", "NetworkError")
   * that tells the reader nothing. It becomes a message naming the host this
   * deployment is actually configured to talk to — which is the fact that
   * distinguishes a wrong VITE_SUPABASE_URL from a real outage.
   */
  it('replaces an opaque network failure with the host it could not reach', () => {
    const message = authErrorMessage(new TypeError('Failed to fetch'));

    expect(message).not.toContain('Failed to fetch');
    expect(message).toMatch(/authentication service at/i);
  });
});
