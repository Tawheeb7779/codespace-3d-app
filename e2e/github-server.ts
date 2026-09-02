/**
 * Serves the integration-test GitHub API over HTTP so a real browser can talk
 * to it.
 *
 * It is the *same* `FakeGithub` the unit tests use — real git object ids, real
 * fast-forward enforcement — exposed on localhost. The browser test points
 * `https://api.github.com` at this server, so everything above the network hop
 * is the shipping code path: the store, the client, the Git planner, the panel.
 *
 *   npx vite-node e2e/github-server.ts
 *
 * Control endpoints (outside the GitHub API surface) let a test set the
 * repository up and inspect what actually landed:
 *
 *   POST /__control/reset   { repos: [{ owner, name, files?, branch? }] }
 *   GET  /__control/state   -> refs and file contents per repository
 *   POST /__control/commit  { owner, name, branch, files, message }
 */
import { createServer } from 'node:http';
import { FakeGithub } from '../src/test/githubApi';

const PORT = Number(process.env.FORGE_GITHUB_PORT ?? 8877);
let api = new FakeGithub({ login: 'forge-tester' });

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'access-control-expose-headers': '*',
  });
  res.end(text);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    });
    res.end();
    return;
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = raw ? JSON.parse(raw) : undefined;

      if (url.pathname === '/__control/reset') {
        api = new FakeGithub({ login: 'forge-tester' });
        for (const spec of body?.repos ?? []) {
          const repo = api.createRepo(spec.owner, spec.name, {
            private: spec.private,
            canPush: spec.canPush,
            protectedBranches: spec.protectedBranches,
          });
          if (spec.files) repo.seed(spec.branch ?? 'main', spec.files, spec.message ?? 'Initial commit');
        }
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/__control/state') {
        const state: Record<string, unknown> = {};
        for (const [key, repo] of api.repos) {
          const refs: Record<string, { sha: string; files: Record<string, string> }> = {};
          for (const [branch, sha] of repo.refs) {
            refs[branch] = { sha, files: repo.filesAt(sha) };
          }
          state[key] = { refs, requests: api.requests.length };
        }
        return send(res, 200, state);
      }

      if (url.pathname === '/__control/commit') {
        const repo = api.repo(body.owner, body.name);
        if (!repo) return send(res, 404, { message: 'no such repository' });
        const sha = repo.seed(body.branch ?? 'main', body.files, body.message ?? 'Remote change');
        return send(res, 200, { sha });
      }

      if (url.pathname === '/__control/fail') {
        api.failWith = body?.failWith ?? null;
        return send(res, 200, { ok: true });
      }

      // Everything else is the GitHub API surface.
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => (query[key] = value));
      const result = await api.transport({
        method: req.method ?? 'GET',
        path: url.pathname,
        query,
        body,
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': '*',
      };
      for (const name of [
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'retry-after',
      ]) {
        const value = result.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res.writeHead(result.status, headers);
      res.end(JSON.stringify(result.body ?? null));
    })().catch((error) => send(res, 500, { message: String(error) }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`github test api on http://127.0.0.1:${PORT}`);
});
