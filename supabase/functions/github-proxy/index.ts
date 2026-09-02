/**
 * The only path from a Forge browser session to the GitHub API.
 *
 * The client sends an abstract request; this function decides whether the
 * caller may make it, attaches the server-held credential, and returns the
 * response. Three checks stand between a request and GitHub:
 *
 *  1. The Supabase JWT must resolve to a real user, and that user must have a
 *     stored GitHub credential. The credential used is always the caller's own
 *     — there is no code path that reaches another user's token.
 *  2. The path must match one of the routes below. Nothing is forwarded on
 *     trust: an unlisted path is a 403, and every identifier interpolated into
 *     a GitHub URL is re-validated here even though the client validated it.
 *  3. A write aimed at a project's repository requires the editor role on that
 *     project *and* must target the repository that project is connected to.
 *     A viewer with push rights on GitHub still cannot push a Forge project.
 *
 * The token never appears in the response, in a log line, or in a URL.
 */

import {
  CORS_HEADERS,
  GITHUB_API,
  HttpError,
  accessTokenFor,
  atLeast,
  fail,
  json,
  markRevoked,
  projectRole,
  requireUser,
  serviceClient,
} from '../_shared/github.ts';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

type Scope = 'account' | 'repo-read' | 'repo-write';

interface Route {
  method: string;
  pattern: RegExp;
  scope: Scope;
}

/**
 * Every request Forge is allowed to make, in the order it is matched.
 * Capture groups are `owner`, `repo` and, where present, a ref or object id.
 */
const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/user$/, scope: 'account' },
  { method: 'GET', pattern: /^\/rate_limit$/, scope: 'account' },
  { method: 'GET', pattern: /^\/user\/repos$/, scope: 'account' },
  { method: 'POST', pattern: /^\/user\/repos$/, scope: 'account' },
  { method: 'GET', pattern: /^\/search\/repositories$/, scope: 'account' },

  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/branches$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/commits$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([0-9a-f]{40})$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/, scope: 'repo-read' },
  { method: 'GET', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([0-9a-f]{40})$/, scope: 'repo-read' },

  { method: 'POST', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/, scope: 'repo-write' },
  { method: 'POST', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/, scope: 'repo-write' },
  { method: 'POST', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/, scope: 'repo-write' },
  { method: 'POST', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, scope: 'repo-write' },
  { method: 'PATCH', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/, scope: 'repo-write' },
  { method: 'DELETE', pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/, scope: 'repo-write' },
];

/** Query parameters that may be forwarded, per endpoint family. */
const ALLOWED_QUERY = new Set([
  'per_page',
  'page',
  'sort',
  'affiliation',
  'q',
  'sha',
  'recursive',
]);

interface Matched {
  route: Route;
  owner: string | null;
  repo: string | null;
}

function matchRoute(method: string, path: string): Matched {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const owner = match[1] ?? null;
    const repo = match[2] ?? null;
    if (route.scope !== 'account') {
      if (!owner || !OWNER.test(owner)) throw new HttpError(400, 'Invalid repository owner.');
      if (!repo || !REPO.test(repo)) throw new HttpError(400, 'Invalid repository name.');
      const ref = match[3];
      if (ref && !SHA.test(ref)) {
        const decoded = decodeURIComponent(ref);
        const bad =
          decoded.includes('..') ||
          decoded.includes('//') ||
          decoded.startsWith('-') ||
          decoded.startsWith('/') ||
          decoded.endsWith('/') ||
          // eslint-disable-next-line no-control-regex
          /[\x00-\x20~^:?*[\]\\]/.test(decoded);
        if (bad) throw new HttpError(400, 'Invalid branch name.');
      }
    }
    return { route, owner, repo };
  }
  throw new HttpError(403, `Forge does not proxy ${method} ${path}.`);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return fail(405, 'Use POST.');

  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      method?: string;
      path?: string;
      query?: Record<string, string | number>;
      body?: unknown;
      projectId?: string;
    };

    const method = String(payload.method ?? 'GET').toUpperCase();
    const path = String(payload.path ?? '');
    if (!path.startsWith('/') || path.includes('..') || path.length > 400) {
      throw new HttpError(400, 'Invalid GitHub path.');
    }

    const matched = matchRoute(method, path);

    // A write against a repository is a project action, so it needs a project
    // and a role on it — GitHub permissions alone are not enough.
    if (matched.route.scope === 'repo-write') {
      const projectId = String(payload.projectId ?? '');
      if (!projectId) throw new HttpError(400, 'A project is required for this operation.');
      const role = await projectRole(user.id, projectId);
      if (!atLeast(role, 'editor')) {
        throw new HttpError(403, 'You need the editor role on this project to change its repository.');
      }
      const { data: remote } = await serviceClient()
        .from('project_remotes')
        .select('owner, repo')
        .eq('project_id', projectId)
        .maybeSingle();
      if (!remote) throw new HttpError(409, 'This project is not connected to a repository.');
      if (remote.owner !== matched.owner || remote.repo !== matched.repo) {
        throw new HttpError(
          403,
          'That request targets a repository this project is not connected to.',
        );
      }
    }

    const token = await accessTokenFor(user.id);
    if (!token) throw new HttpError(428, 'Connect your GitHub account first.');

    const url = new URL(GITHUB_API + path);
    for (const [key, value] of Object.entries(payload.query ?? {})) {
      if (!ALLOWED_QUERY.has(key)) continue;
      url.searchParams.set(key, String(value));
    }

    const upstream = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'forge-ide',
        ...(payload.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload.body === undefined ? undefined : JSON.stringify(payload.body),
    });

    if (upstream.status === 401) await markRevoked(user.id);

    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { message: text.slice(0, 400) };
    }

    // Forward only the headers the client reasons about; nothing else leaks.
    return json(
      {
        status: upstream.status,
        headers: {
          'x-ratelimit-limit': upstream.headers.get('x-ratelimit-limit'),
          'x-ratelimit-remaining': upstream.headers.get('x-ratelimit-remaining'),
          'x-ratelimit-reset': upstream.headers.get('x-ratelimit-reset'),
          'retry-after': upstream.headers.get('retry-after'),
        },
        body: parsed,
      },
      200,
    );
  } catch (error) {
    if (error instanceof HttpError) return fail(error.status, error.message);
    // Never surface an internal message: it could carry request details.
    console.error('github-proxy failure', error instanceof Error ? error.name : 'unknown');
    return fail(500, 'The GitHub proxy failed. Try again.');
  }
});
