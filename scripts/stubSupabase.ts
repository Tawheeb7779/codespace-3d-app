import { createServer, type Server } from 'node:http';

/**
 * Enough of Supabase to drive `verify-cloud-save.mjs` end to end.
 *
 * The verify script is the only proof that cloud persistence works, so it has
 * to be known-good before anyone reads its output — and its riskiest part is
 * the OAuth round trip, which cannot be exercised against a real project from
 * a test. This stub speaks the handful of endpoints that flow touches: the
 * authorize redirect, the PKCE token exchange, `GET /auth/v1/user`, and the
 * PostgREST verbs the checks use.
 *
 * It is deliberately not a Supabase emulator. It records what it was asked for
 * so a test can assert the script sent the right statements, and it can be told
 * to refuse a specific one so the failure paths are exercised too.
 */

export interface StubOptions {
  /** Refuse the projects insert, the way an unapplied 0007 does. */
  refuseProjectInsert?: boolean;
  /** Accept the file upsert but store nothing, the way a bad policy does. */
  swallowFileUpsert?: boolean;
  /** Match no rows on the project update, the way an unapplied 0005 does. */
  refuseProjectUpdate?: boolean;
  /** Accept a project filed under someone else — which must fail the run. */
  allowForeignProject?: boolean;
}

export interface StubRequest {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

export interface StubSupabase {
  url: string;
  anonKey: string;
  requests: StubRequest[];
  /** Rows the stub is holding, so a test can see what really landed. */
  projects: Map<string, Record<string, unknown>>;
  files: Map<string, Record<string, unknown>>;
  close: () => Promise<void>;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

/** A JWT-shaped string. Nothing verifies it; the stub is the only reader. */
const token = (role: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, sub: USER_ID })).toString('base64url'),
    'stub-signature',
  ].join('.');

export const STUB_USER_ID = USER_ID;
export const STUB_ANON_KEY = token('anon');

export async function startStubSupabase(options: StubOptions = {}): Promise<StubSupabase> {
  const requests: StubRequest[] = [];
  const projects = new Map<string, Record<string, unknown>>();
  const files = new Map<string, Record<string, unknown>>();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* keep the raw text */
      }
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        body,
      });

      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      // --------------------------------------------------------------- auth
      if (url.pathname === '/auth/v1/authorize') {
        // What the provider does after the person signs in: come back with a
        // code on the redirect the client asked for.
        const back = url.searchParams.get('redirect_to');
        if (!back) return send(400, { error: 'no redirect_to' });
        const target = new URL(back);
        target.searchParams.set('code', 'stub-authorization-code');
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }

      if (url.pathname === '/auth/v1/token') {
        return send(200, {
          access_token: token('authenticated'),
          refresh_token: 'stub-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: USER_ID, email: 'oauth-user@example.com', app_metadata: {} },
        });
      }

      if (url.pathname === '/auth/v1/user') {
        return send(200, { id: USER_ID, email: 'oauth-user@example.com', app_metadata: {} });
      }

      if (url.pathname === '/auth/v1/logout') return send(204, undefined);

      // ----------------------------------------------------------- postgrest
      if (url.pathname === '/rest/v1/profiles') {
        return send(200, [{ id: USER_ID }]);
      }

      if (url.pathname === '/rest/v1/rpc/can_write_project') {
        return send(404, { code: 'PGRST202', message: 'function not found' });
      }

      if (url.pathname === '/rest/v1/projects') {
        if (request.method === 'POST') {
          const rows = Array.isArray(body) ? body : [body];
          const row = rows[0] as Record<string, unknown>;
          const mine = row?.owner_id === USER_ID;
          if (!mine && !options.allowForeignProject) {
            return send(403, {
              code: '42501',
              message: 'new row violates row-level security policy for table "projects"',
            });
          }
          if (mine && options.refuseProjectInsert) {
            return send(403, {
              code: '42501',
              message: 'new row violates row-level security policy for table "projects"',
            });
          }
          projects.set(String(row.id), { ...row, dirs: row.dirs ?? [] });
          return send(201, [projects.get(String(row.id))]);
        }
        if (request.method === 'PATCH') {
          const id = /id=eq\.([^&]+)/.exec(url.search)?.[1];
          const existing = id ? projects.get(id) : undefined;
          if (!existing || options.refuseProjectUpdate) return send(200, []);
          const patch = body as Record<string, unknown>;
          projects.set(id!, { ...existing, ...patch });
          return send(200, [projects.get(id!)]);
        }
        if (request.method === 'DELETE') {
          const id = /id=eq\.([^&]+)/.exec(url.search)?.[1];
          if (id) projects.delete(id);
          return send(200, []);
        }
        // GET
        const id = /id=eq\.([^&]+)/.exec(url.search)?.[1];
        const found = id ? projects.get(id) : undefined;
        return send(200, found ? [found] : []);
      }

      if (url.pathname === '/rest/v1/project_files') {
        if (request.method === 'POST') {
          const rows = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
          if (options.swallowFileUpsert) return send(201, []);
          for (const row of rows) files.set(`${row.project_id}:${row.path}`, row);
          return send(201, rows.map((row) => ({ path: row.path })));
        }
        if (request.method === 'DELETE') return send(200, []);
        const projectId = /project_id=eq\.([^&]+)/.exec(url.search)?.[1];
        const mine = [...files.values()].filter((row) => row.project_id === projectId);
        return send(200, mine.map((row) => ({ path: row.path, content: row.content })));
      }

      send(404, { message: `stub has no route for ${request.method} ${url.pathname}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the stub did not bind a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    anonKey: STUB_ANON_KEY,
    requests,
    projects,
    files,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
