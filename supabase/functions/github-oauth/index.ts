/**
 * GitHub OAuth, both halves, server side.
 *
 *   POST { action: "start"  }  -> { url }        authorize URL with a bound state
 *   POST { action: "finish", code, state } -> { login, scopes }
 *   POST { action: "status" }  -> connection status
 *   POST { action: "disconnect" } -> revokes the grant with GitHub and forgets it
 *
 * The client secret is read from the function's environment and used only in
 * the token exchange. The resulting access token is written straight into
 * `private.github_tokens`, a schema no browser role can reach, and is never
 * included in a response.
 *
 * `state` is generated here, stored against the caller's user id, and consumed
 * once. A callback carrying somebody else's state therefore cannot attach a
 * GitHub account to the wrong Forge user, and a replayed callback fails.
 */

import {
  CORS_HEADERS,
  HttpError,
  fail,
  json,
  requireUser,
  serviceClient,
} from '../_shared/github.ts';

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
/** `repo` covers private repositories; drop to `public_repo` if that is enough. */
const SCOPES = Deno.env.get('GITHUB_OAUTH_SCOPES') ?? 'repo read:user';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `${name} is not configured on the server.`);
  return value;
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return fail(405, 'Use POST.');

  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      action?: string;
      code?: string;
      state?: string;
      redirect?: string;
    };
    const client = serviceClient();

    switch (payload.action) {
      case 'start': {
        const clientId = requireEnv('GITHUB_CLIENT_ID');
        const appOrigin = requireEnv('FORGE_APP_ORIGIN');
        const redirect = `${appOrigin.replace(/\/+$/, '')}/settings/github/callback`;
        const state = randomState();
        await client.schema('private').from('github_oauth_states').insert({
          state,
          user_id: user.id,
          redirect,
        });
        const url = new URL(AUTHORIZE);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirect);
        url.searchParams.set('scope', SCOPES);
        url.searchParams.set('state', state);
        url.searchParams.set('allow_signup', 'false');
        return json({ url: url.toString() });
      }

      case 'finish': {
        const code = String(payload.code ?? '');
        const state = String(payload.state ?? '');
        if (!code || !state) throw new HttpError(400, 'Missing OAuth code or state.');

        // Consume the state exactly once, and only if it belongs to the caller.
        const { data: pending } = await client
          .schema('private')
          .from('github_oauth_states')
          .select('user_id, redirect, expires_at')
          .eq('state', state)
          .maybeSingle();
        await client.schema('private').from('github_oauth_states').delete().eq('state', state);

        if (!pending || pending.user_id !== user.id) {
          throw new HttpError(400, 'This sign-in link is not valid for your session. Start again.');
        }
        if (new Date(pending.expires_at).getTime() < Date.now()) {
          throw new HttpError(400, 'The GitHub sign-in expired. Start again.');
        }

        const exchange = await fetch(TOKEN, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: requireEnv('GITHUB_CLIENT_ID'),
            client_secret: requireEnv('GITHUB_CLIENT_SECRET'),
            code,
            redirect_uri: pending.redirect,
          }),
        });
        const grant = (await exchange.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          error_description?: string;
          error?: string;
        };
        if (!exchange.ok || !grant.access_token) {
          throw new HttpError(
            400,
            grant.error_description || grant.error || 'GitHub refused the authorization.',
          );
        }

        const who = await fetch('https://api.github.com/user', {
          headers: {
            authorization: `Bearer ${grant.access_token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'forge-ide',
          },
        });
        if (!who.ok) throw new HttpError(400, 'Could not read the GitHub account for that grant.');
        const account = (await who.json()) as { login: string; id: number; avatar_url: string };

        const expiresAt = grant.expires_in
          ? new Date(Date.now() + grant.expires_in * 1000).toISOString()
          : null;

        await client.schema('private').from('github_tokens').upsert({
          user_id: user.id,
          access_token: grant.access_token,
          refresh_token: grant.refresh_token ?? null,
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        });
        await client.from('github_connections').upsert({
          user_id: user.id,
          github_login: account.login,
          github_user_id: account.id,
          avatar_url: account.avatar_url,
          scopes: (grant.scope ?? '').split(',').filter(Boolean),
          connected_at: new Date().toISOString(),
          revoked_at: null,
        });

        return json({ login: account.login, scopes: (grant.scope ?? '').split(',').filter(Boolean) });
      }

      case 'status': {
        const { data } = await client
          .from('github_connections')
          .select('github_login, avatar_url, scopes, connected_at, revoked_at')
          .eq('user_id', user.id)
          .maybeSingle();
        return json({ connection: data ?? null });
      }

      case 'disconnect': {
        // Ask GitHub to drop the grant as well, so "Disconnect" means it.
        const { data } = await client
          .schema('private')
          .from('github_tokens')
          .select('access_token')
          .eq('user_id', user.id)
          .maybeSingle();
        const clientId = Deno.env.get('GITHUB_CLIENT_ID');
        const clientSecret = Deno.env.get('GITHUB_CLIENT_SECRET');
        if (data?.access_token && clientId && clientSecret) {
          await fetch(`https://api.github.com/applications/${clientId}/grant`, {
            method: 'DELETE',
            headers: {
              authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
              accept: 'application/vnd.github+json',
              'content-type': 'application/json',
              'user-agent': 'forge-ide',
            },
            body: JSON.stringify({ access_token: data.access_token }),
          }).catch(() => undefined);
        }
        await client.schema('private').from('github_tokens').delete().eq('user_id', user.id);
        await client.from('github_connections').delete().eq('user_id', user.id);
        return json({ disconnected: true });
      }

      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (error) {
    if (error instanceof HttpError) return fail(error.status, error.message);
    console.error('github-oauth failure', error instanceof Error ? error.name : 'unknown');
    return fail(500, 'The GitHub sign-in failed. Try again.');
  }
});
