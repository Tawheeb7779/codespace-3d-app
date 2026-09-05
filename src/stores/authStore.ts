import { create } from 'zustand';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { idbGet, idbSet, idbDelete } from '@/lib/idb';
import { errorMessage, uid } from '@/lib/utils';
import type { AuthUser } from '@/types';

/**
 * Authentication.
 *
 * With Supabase configured this wraps Supabase Auth (email/password plus Google
 * and GitHub OAuth). Without it the app runs in Local Development Mode: a
 * local-only account is created on demand and everything persists to IndexedDB.
 * The mode is surfaced in the UI so nobody mistakes local data for cloud data.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  /** True when running without Supabase. */
  localMode: boolean;
  busy: boolean;
  initialize: () => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithOAuth: (provider: 'google' | 'github') => Promise<void>;
  signInLocally: (displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

/** The persisted local account. Survives sign-out so projects keep their owner. */
const LOCAL_ACCOUNT_KEY = 'local-account';
/** Whether that account currently has an active session. */
const LOCAL_SESSION_KEY = 'local-session';

function fromSupabaseUser(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}): AuthUser {
  const meta = user.user_metadata ?? {};
  const provider = (user.app_metadata?.provider as string) ?? 'email';
  return {
    id: user.id,
    email: user.email ?? '',
    displayName:
      (meta.full_name as string) ||
      (meta.name as string) ||
      (meta.user_name as string) ||
      user.email?.split('@')[0] ||
      'Developer',
    avatarUrl: (meta.avatar_url as string) ?? null,
    provider: provider === 'google' || provider === 'github' ? provider : 'email',
  };
}

/**
 * Leave the single-page app and load `path` fresh.
 *
 * Used when the account changes. Every other store — projects, workspaces,
 * editor tabs, version history, the GitHub connection — is scoped to whoever
 * was signed in, and a client-side navigation keeps all of it in memory for
 * the next person. A real load is the only way to be sure none of it survives.
 */
export function reloadInto(path: string): void {
  if (typeof window === 'undefined') return;
  window.location.assign(path);
}

function validate(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'loading',
  user: null,
  error: null,
  localMode: !isSupabaseConfigured,
  busy: false,

  async initialize() {
    // Restoring a session is asynchronous. If the user signs in while it is in
    // flight, a late result must not overwrite the newer, real session.
    const stillRestoring = () => get().status === 'loading';

    if (!supabase) {
      const active = await idbGet<boolean>('kv', LOCAL_SESSION_KEY);
      const account = active ? await idbGet<AuthUser>('kv', LOCAL_ACCOUNT_KEY) : null;
      if (!stillRestoring()) return;
      set({
        user: account ?? null,
        status: account ? 'authenticated' : 'anonymous',
        localMode: true,
      });
      return;
    }
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      const user = data.session?.user ? fromSupabaseUser(data.session.user) : null;
      if (stillRestoring()) set({ user, status: user ? 'authenticated' : 'anonymous' });
      supabase.auth.onAuthStateChange((_event, session) => {
        const next = session?.user ? fromSupabaseUser(session.user) : null;
        const previous = get().user;
        set({ user: next, status: next ? 'authenticated' : 'anonymous' });
        // A different person now holds this tab. Projects, workspaces, open
        // tabs, git state and the GitHub connection all belong to the account
        // that left, so start the next one from a clean process rather than
        // hoping every store remembered to clear itself.
        if (next && previous && next.id !== previous.id) reloadInto('/dashboard');
      });
    } catch (error) {
      if (stillRestoring()) set({ status: 'anonymous', error: errorMessage(error) });
    }
  },

  async signUp(email, password, displayName) {
    const invalid = validate(email, password);
    if (invalid) {
      set({ error: invalid });
      throw new Error(invalid);
    }
    if (!supabase) {
      await get().signInLocally(displayName || email.split('@')[0]);
      return;
    }
    set({ busy: true, error: null });
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: displayName.trim() || email.split('@')[0] } },
      });
      if (error) throw error;
      if (data.user && !data.session) {
        set({ error: 'Check your inbox to confirm this address, then sign in.' });
        return;
      }
      if (data.user) set({ user: fromSupabaseUser(data.user), status: 'authenticated' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ busy: false });
    }
  },

  async signIn(email, password) {
    const invalid = validate(email, password);
    if (invalid) {
      set({ error: invalid });
      throw new Error(invalid);
    }
    if (!supabase) {
      await get().signInLocally(email.split('@')[0]);
      return;
    }
    set({ busy: true, error: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      set({ user: fromSupabaseUser(data.user), status: 'authenticated' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ busy: false });
    }
  },

  async signInWithOAuth(provider) {
    if (!supabase) {
      const message =
        'OAuth needs Supabase. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or continue in Local Development Mode.';
      set({ error: message });
      throw new Error(message);
    }
    set({ busy: true, error: null });
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      // The browser navigates away; state is restored by initialize() on return.
    } catch (error) {
      set({ error: errorMessage(error), busy: false });
      throw error;
    }
  },

  async signInLocally(displayName) {
    set({ busy: true, error: null });
    try {
      const existing = await idbGet<AuthUser>('kv', LOCAL_ACCOUNT_KEY);
      const user: AuthUser = existing ?? {
        id: uid('local-user'),
        email: 'you@localhost',
        displayName: displayName?.trim() || 'Local Developer',
        avatarUrl: null,
        provider: 'local',
      };
      if (displayName?.trim()) user.displayName = displayName.trim();
      await idbSet('kv', LOCAL_ACCOUNT_KEY, user);
      await idbSet('kv', LOCAL_SESSION_KEY, true);
      set({ user, status: 'authenticated', localMode: true });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ busy: false });
    }
  },

  async signOut() {
    const { user } = get();
    set({ busy: true });
    try {
      if (user?.provider === 'local') {
        // Keep the account record so its projects keep an owner; end the session only.
        await idbDelete('kv', LOCAL_SESSION_KEY);
      } else if (supabase) {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      }
      set({ user: null, status: 'anonymous', error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ busy: false });
    }
  },

  clearError: () => set({ error: null }),
}));
