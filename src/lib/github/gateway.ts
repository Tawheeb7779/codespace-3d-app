import { GithubClient, type GithubRequest, type GithubResponse } from '@/lib/github/client';
import { GithubError } from '@/lib/github/errors';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/**
 * How a GitHub request leaves the browser.
 *
 * Two transports, one client. Which one is active is a deployment property,
 * not a behavioural one: the Git logic above does not know or care.
 *
 *   `edge`   — the request goes to a Supabase Edge Function that holds the
 *              credential server side. Nothing secret is in the browser. This
 *              is the only mode a deployed Forge should run.
 *
 *   `direct` — Local Development Mode, where there is no server to mediate.
 *              The developer supplies their own token; it is kept in
 *              `sessionStorage` for the tab's lifetime, in one module, and is
 *              never persisted to disk, never put in a URL and never handed to
 *              project code or the AI agent. The UI states this plainly rather
 *              than pretending the local path is as safe as the hosted one.
 */

export type TransportMode = 'edge' | 'direct' | 'none';

const TOKEN_KEY = 'forge.github.pat';

/**
 * Session-scoped storage for a local-mode token.
 *
 * `sessionStorage`, not `localStorage`: the credential dies with the tab, so a
 * shared machine does not keep it, and it never reaches a backup or a sync.
 */
export function readLocalToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeLocalToken(token: string): void {
  try {
    if (token.trim()) sessionStorage.setItem(TOKEN_KEY, token.trim());
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // A browser with storage disabled simply has no local-mode connection.
  }
}

export function hasLocalToken(): boolean {
  return Boolean(readLocalToken());
}

const GITHUB_API = 'https://api.github.com';

function headersOf(source: Headers): { get(name: string): string | null } {
  return { get: (name) => source.get(name) };
}

/** Talk to GitHub directly with the tab's token. Local Development Mode only. */
export function directTransport(projectId?: string): (r: GithubRequest) => Promise<GithubResponse> {
  void projectId;
  return async (request) => {
    const token = readLocalToken();
    if (!token) throw new GithubError('not-connected', 'Connect a GitHub account first.');
    const url = new URL(GITHUB_API + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 400) };
    }
    return { status: response.status, headers: headersOf(response.headers), body };
  };
}

/** Route through the Edge Function, which holds the credential. */
export function edgeTransport(projectId?: string): (r: GithubRequest) => Promise<GithubResponse> {
  return async (request) => {
    if (!supabase) throw new GithubError('not-connected', 'Supabase is not configured.');
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new GithubError('unauthorized', 'Your Forge session has expired.');

    const { data: result, error } = await supabase.functions.invoke<{
      status: number;
      headers: Record<string, string | null>;
      body: unknown;
    }>('github-proxy', {
      body: { ...request, projectId },
    });

    if (error || !result) {
      throw new GithubError('network', error?.message || 'The GitHub proxy did not respond.');
    }
    return {
      status: result.status,
      headers: { get: (name) => result.headers?.[name.toLowerCase()] ?? null },
      body: result.body,
    };
  };
}

export function transportMode(): TransportMode {
  if (isSupabaseConfigured) return 'edge';
  return hasLocalToken() ? 'direct' : 'none';
}

/**
 * A client bound to the active transport.
 *
 * `projectId` scopes writes: the proxy uses it to check the caller's role on
 * that project and to confirm the request targets the repository the project
 * is actually connected to.
 */
export function githubClient(projectId?: string): GithubClient {
  const mode = transportMode();
  if (mode === 'none') {
    throw new GithubError('not-connected', 'Connect a GitHub account first.');
  }
  return new GithubClient(mode === 'edge' ? edgeTransport(projectId) : directTransport(projectId));
}
