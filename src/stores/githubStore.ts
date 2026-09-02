import { create } from 'zustand';
import { GithubError } from '@/lib/github/errors';
import {
  githubClient,
  hasLocalToken,
  transportMode,
  writeLocalToken,
  type TransportMode,
} from '@/lib/github/gateway';
import type { GithubAccount, GithubBranch, GithubRepo, RateLimit } from '@/lib/github/types';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

/**
 * The GitHub *account* connection, kept separate from any one project's remote.
 *
 * A user connects GitHub once; projects then point at repositories that
 * connection can reach. Nothing here holds a credential: in the hosted mode the
 * token lives in the Edge Function's database, and in Local Development Mode it
 * lives in `sessionStorage` behind `lib/github/gateway`, which this store only
 * ever asks yes/no questions about.
 */

export type ConnectionStatus = 'unknown' | 'checking' | 'connected' | 'disconnected' | 'revoked';

interface GithubState {
  status: ConnectionStatus;
  mode: TransportMode;
  account: GithubAccount | null;
  scopes: string[];
  error: string | null;
  rateLimit: RateLimit | null;

  /** Repository browser. */
  repos: GithubRepo[];
  query: string;
  page: number;
  hasNextPage: boolean;
  loadingRepos: boolean;
  reposError: string | null;

  refreshConnection: () => Promise<void>;
  connectWithToken: (token: string) => Promise<void>;
  beginOAuth: () => Promise<string>;
  completeOAuth: (code: string, state: string) => Promise<void>;
  disconnect: () => Promise<void>;
  searchRepos: (query: string, page?: number) => Promise<void>;
  listBranches: (repo: GithubRepo) => Promise<GithubBranch[]>;
  createRepo: (input: {
    name: string;
    description: string;
    private: boolean;
    autoInit: boolean;
  }) => Promise<GithubRepo>;
  clearError: () => void;
}

async function invokeOAuth<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new GithubError('not-connected', 'Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke<T>('github-oauth', {
    body: { action, ...payload },
  });
  if (error) throw new GithubError('network', error.message || 'GitHub sign-in failed.');
  return data as T;
}

export const useGithubStore = create<GithubState>()((set, get) => ({
  status: 'unknown',
  mode: 'none',
  account: null,
  scopes: [],
  error: null,
  rateLimit: null,

  repos: [],
  query: '',
  page: 1,
  hasNextPage: false,
  loadingRepos: false,
  reposError: null,

  async refreshConnection() {
    set({ status: 'checking', error: null, mode: transportMode() });
    try {
      if (isSupabaseConfigured) {
        const { connection } = await invokeOAuth<{
          connection: {
            github_login: string;
            avatar_url: string | null;
            scopes: string[];
            revoked_at: string | null;
          } | null;
        }>('status');
        if (!connection) {
          set({ status: 'disconnected', account: null, scopes: [], mode: 'edge' });
          return;
        }
        if (connection.revoked_at) {
          set({
            status: 'revoked',
            account: { login: connection.github_login, id: 0, avatarUrl: connection.avatar_url, name: null },
            scopes: connection.scopes,
            error: 'GitHub access was revoked. Reconnect to continue.',
          });
          return;
        }
        set({
          status: 'connected',
          account: {
            login: connection.github_login,
            id: 0,
            avatarUrl: connection.avatar_url,
            name: null,
          },
          scopes: connection.scopes,
          mode: 'edge',
        });
        return;
      }

      if (!hasLocalToken()) {
        set({ status: 'disconnected', account: null, scopes: [], mode: 'none' });
        return;
      }
      // Local mode: the only proof a token still works is asking GitHub.
      const client = githubClient();
      const account = await client.viewer();
      const rateLimit = await client.rateLimit().catch(() => null);
      set({ status: 'connected', account, mode: 'direct', rateLimit, scopes: [] });
    } catch (error) {
      if (error instanceof GithubError && error.needsReconnect) {
        set({ status: 'revoked', error: error.message });
        return;
      }
      set({ status: 'disconnected', error: errorMessage(error) });
    }
  },

  async connectWithToken(token) {
    if (isSupabaseConfigured) {
      throw new GithubError(
        'forbidden',
        'This deployment connects GitHub through its server. Use "Connect GitHub" instead of a token.',
      );
    }
    writeLocalToken(token);
    try {
      await get().refreshConnection();
      if (get().status !== 'connected') throw new GithubError('unauthorized', get().error ?? 'Token rejected.');
    } catch (error) {
      // Never keep a credential that did not work.
      writeLocalToken('');
      set({ status: 'disconnected' });
      throw error;
    }
  },

  async beginOAuth() {
    const { url } = await invokeOAuth<{ url: string }>('start');
    return url;
  },

  async completeOAuth(code, state) {
    await invokeOAuth('finish', { code, state });
    await get().refreshConnection();
  },

  async disconnect() {
    set({ error: null });
    try {
      if (isSupabaseConfigured) await invokeOAuth('disconnect');
      else writeLocalToken('');
      set({ status: 'disconnected', account: null, scopes: [], repos: [], rateLimit: null });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  async searchRepos(query, page = 1) {
    set({ loadingRepos: true, reposError: null, query, page });
    try {
      const client = githubClient();
      const result = query.trim()
        ? await client.searchRepos(query, page)
        : await client.listRepos(page);
      set({
        repos: result.items,
        hasNextPage: result.hasNextPage,
        loadingRepos: false,
      });
    } catch (error) {
      set({ loadingRepos: false, reposError: errorMessage(error), repos: [] });
      if (error instanceof GithubError && error.needsReconnect) set({ status: 'revoked' });
    }
  },

  async listBranches(repo) {
    const client = githubClient();
    const first = await client.listBranches({ owner: repo.owner, repo: repo.name });
    return first.items;
  },

  async createRepo(input) {
    const client = githubClient();
    return client.createRepo(input);
  },

  clearError: () => set({ error: null, reposError: null }),
}));
