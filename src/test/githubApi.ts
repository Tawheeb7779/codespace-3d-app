import { createHash } from 'node:crypto';

/**
 * A GitHub Git Data API implementation for integration tests.
 *
 * This is not a mock that answers whatever the client expects. It stores real
 * git objects under their real SHA-1 names — `blob <len>\0…`, sorted tree
 * entries with raw 20-byte ids, canonical commit text — and enforces the same
 * rules GitHub does: a non-fast-forward ref update is rejected with 422, a
 * missing ref is a 404, an unauthorised push is a 403.
 *
 * That matters because the object ids and the fast-forward check are exactly
 * what a hand-written mock would get wrong, and they are the part of the push
 * path most worth testing. Verified against `git hash-object` in
 * `github.objects.test.ts`.
 */

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return sha1(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]));
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
  type: 'blob' | 'tree';
}

function gitTreeSha(entries: TreeEntry[]): string {
  // git sorts entries by name, with a trailing slash implied for directories.
  const sorted = [...entries].sort((a, b) => {
    const left = a.type === 'tree' ? `${a.name}/` : a.name;
    const right = b.type === 'tree' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const body = Buffer.concat(
    sorted.map((entry) =>
      Buffer.concat([
        // git writes the mode as octal with no leading zero ("40000" for a
        // tree), even though the REST API reports it padded ("040000").
        Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.name}\0`),
        Buffer.from(entry.sha, 'hex'),
      ]),
    ),
  );
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
}

function gitCommitSha(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return sha1(Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]));
}

interface StoredTree {
  entries: TreeEntry[];
}

interface StoredCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
}

export interface RepoOptions {
  private?: boolean;
  canPush?: boolean;
  defaultBranch?: string;
  protectedBranches?: string[];
}

class Repository {
  blobs = new Map<string, string>();
  trees = new Map<string, StoredTree>();
  commits = new Map<string, StoredCommit>();
  refs = new Map<string, string>();
  readonly id: number;
  readonly defaultBranch: string;
  readonly protectedBranches: Set<string>;
  canPush: boolean;
  private_: boolean;
  pushedAt: string | null = null;

  constructor(
    readonly owner: string,
    readonly name: string,
    id: number,
    options: RepoOptions = {},
  ) {
    this.id = id;
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.canPush = options.canPush ?? true;
    this.private_ = options.private ?? false;
    this.protectedBranches = new Set(options.protectedBranches ?? []);
  }

  /** Build nested trees from a flat path map and store every object. */
  writeTree(files: Record<string, string>): string {
    for (const content of Object.values(files)) {
      this.blobs.set(gitBlobSha(content), content);
    }
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const path of Object.keys(files)) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: '100644', name: rest, type: 'blob', sha: gitBlobSha(files[path]) });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const sub = build(prefix ? `${prefix}/${dir}` : dir);
        entries.push({ mode: '040000', name: dir, type: 'tree', sha: sub });
      }
      const sha = gitTreeSha(entries);
      this.trees.set(sha, { entries });
      return sha;
    };
    return build('');
  }

  /** Flatten a stored tree back into `path -> blob sha`. */
  readTree(sha: string, prefix = ''): Array<{ path: string; sha: string; type: string; mode: string; size: number }> {
    const tree = this.trees.get(sha);
    if (!tree) return [];
    const out: Array<{ path: string; sha: string; type: string; mode: string; size: number }> = [];
    for (const entry of tree.entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        out.push({ path, sha: entry.sha, type: 'tree', mode: entry.mode, size: 0 });
        out.push(...this.readTree(entry.sha, path));
      } else {
        out.push({
          path,
          sha: entry.sha,
          type: 'blob',
          mode: entry.mode,
          size: Buffer.byteLength(this.blobs.get(entry.sha) ?? '', 'utf8'),
        });
      }
    }
    return out;
  }

  filesAt(commitSha: string): Record<string, string> {
    const commit = this.commits.get(commitSha);
    if (!commit) return {};
    const files: Record<string, string> = {};
    for (const entry of this.readTree(commit.tree)) {
      if (entry.type === 'blob') files[entry.path] = this.blobs.get(entry.sha) ?? '';
    }
    return files;
  }

  writeCommit(input: {
    tree: string;
    parents: string[];
    message: string;
    author?: { name: string; email: string };
  }): string {
    const author = input.author ?? { name: 'Tester', email: 'test@example.com' };
    const date = '1700000000 +0000';
    const text =
      `tree ${input.tree}\n` +
      input.parents.map((p) => `parent ${p}\n`).join('') +
      `author ${author.name} <${author.email}> ${date}\n` +
      `committer ${author.name} <${author.email}> ${date}\n\n${input.message}\n`;
    const sha = gitCommitSha(text);
    this.commits.set(sha, {
      sha,
      tree: input.tree,
      parents: input.parents,
      message: input.message,
      author: { ...author, date: '2023-11-14T22:13:20Z' },
    });
    this.pushedAt = new Date().toISOString();
    return sha;
  }

  /** Seed a branch with a commit, the way a real repository starts life. */
  seed(branch: string, files: Record<string, string>, message = 'Initial commit'): string {
    const parent = this.refs.get(branch);
    const tree = this.writeTree(files);
    const sha = this.writeCommit({ tree, parents: parent ? [parent] : [], message });
    this.refs.set(branch, sha);
    return sha;
  }

  isAncestor(candidate: string, of: string): boolean {
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length) {
      const current = queue.pop()!;
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (current === candidate) return true;
      queue.push(...(this.commits.get(current)?.parents ?? []));
    }
    return false;
  }

  history(from: string, limit: number): StoredCommit[] {
    const out: StoredCommit[] = [];
    let cursor: string | undefined = from;
    while (cursor && out.length < limit) {
      const commit = this.commits.get(cursor);
      if (!commit) break;
      out.push(commit);
      cursor = commit.parents[0];
    }
    return out;
  }
}

export interface FakeGithubOptions {
  login?: string;
  /** Force every subsequent request to fail with this status. */
  failWith?: { status: number; message: string; headers?: Record<string, string> } | null;
}

export interface RequestLog {
  method: string;
  path: string;
}

/**
 * The API surface, addressed exactly as the client addresses it. Returns the
 * `{status, headers, body}` shape a transport produces.
 */
export class FakeGithub {
  readonly repos = new Map<string, Repository>();
  readonly requests: RequestLog[] = [];
  login: string;
  failWith: FakeGithubOptions['failWith'] = null;
  rateRemaining = 5000;
  /**
   * Runs before every request is served. A test uses it to change server state
   * mid-operation — the only way to reproduce a ref moving between the check
   * and the update, which is the race a real push has to survive.
   */
  beforeRequest: ((request: { method: string; path: string }) => void) | null = null;
  private nextId = 1000;

  constructor(options: FakeGithubOptions = {}) {
    this.login = options.login ?? 'octocat';
    this.failWith = options.failWith ?? null;
  }

  createRepo(owner: string, name: string, options: RepoOptions = {}): Repository {
    const repo = new Repository(owner, name, (this.nextId += 1), options);
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  repo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  private headers(extra: Record<string, string> = {}) {
    const map: Record<string, string> = {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(this.rateRemaining),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      ...extra,
    };
    return { get: (name: string) => map[name.toLowerCase()] ?? null };
  }

  private ok(body: unknown, status = 200) {
    return { status, headers: this.headers(), body };
  }

  private fail(status: number, message: string, extra: Record<string, string> = {}) {
    return { status, headers: this.headers(extra), body: { message } };
  }

  private repoJson(repo: Repository) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private_,
      default_branch: repo.defaultBranch,
      description: '',
      updated_at: '2024-01-01T00:00:00Z',
      pushed_at: repo.pushedAt,
      owner: { login: repo.owner },
      permissions: { push: repo.canPush, admin: false },
    };
  }

  /** The transport a `GithubClient` is constructed with. */
  transport = async (request: {
    method: string;
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  }) => {
    this.requests.push({ method: request.method, path: request.path });
    this.beforeRequest?.({ method: request.method, path: request.path });
    if (this.failWith) {
      return this.fail(this.failWith.status, this.failWith.message, this.failWith.headers ?? {});
    }
    this.rateRemaining = Math.max(0, this.rateRemaining - 1);

    const { method, path } = request;
    const query = request.query ?? {};
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (method === 'GET' && path === '/user') {
      return this.ok({ login: this.login, id: 1, avatar_url: 'https://example.test/a.png', name: 'Test User' });
    }
    if (method === 'GET' && path === '/rate_limit') {
      return this.ok({
        rate: { limit: 5000, remaining: this.rateRemaining, reset: Math.floor(Date.now() / 1000) + 3600 },
      });
    }
    if (method === 'GET' && path === '/user/repos') {
      const all = [...this.repos.values()].map((r) => this.repoJson(r));
      const per = Number(query.per_page ?? 30);
      const page = Number(query.page ?? 1);
      return this.ok(all.slice((page - 1) * per, page * per));
    }
    if (method === 'POST' && path === '/user/repos') {
      const name = String(body.name);
      if (this.repo(this.login, name)) {
        return this.fail(422, 'Repository creation failed: name already exists on this account');
      }
      const created = this.createRepo(this.login, name, { private: Boolean(body.private) });
      if (body.auto_init) created.seed(created.defaultBranch, { 'README.md': `# ${name}\n` });
      return this.ok(this.repoJson(created), 201);
    }
    if (method === 'GET' && path === '/search/repositories') {
      const term = String(query.q ?? '').replace(/\s*fork:true\s*/, '').toLowerCase();
      const items = [...this.repos.values()]
        .filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(term))
        .map((r) => this.repoJson(r));
      return this.ok({ items, total_count: items.length });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!repoMatch) return this.fail(404, 'Not Found');
    const [, owner, name, rest = ''] = repoMatch;
    const repo = this.repo(owner, name);
    if (!repo) return this.fail(404, 'Not Found');

    if (!rest) return this.ok(this.repoJson(repo));

    if (method === 'GET' && rest === '/branches') {
      const items = [...repo.refs.entries()].map(([branch, sha]) => ({
        name: branch,
        commit: { sha },
        protected: repo.protectedBranches.has(branch),
      }));
      const per = Number(query.per_page ?? 100);
      const page = Number(query.page ?? 1);
      return this.ok(items.slice((page - 1) * per, page * per));
    }

    if (method === 'GET' && rest === '/commits') {
      const from = String(query.sha ?? repo.refs.get(repo.defaultBranch) ?? '');
      const commits = repo.history(from, Number(query.per_page ?? 30));
      return this.ok(
        commits.map((c) => ({
          sha: c.sha,
          commit: { message: c.message, author: { name: c.author.name, date: c.author.date } },
        })),
      );
    }

    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && refMatch) {
      const branch = decodeURIComponent(refMatch[1]);
      const sha = repo.refs.get(branch);
      if (!sha) return this.fail(404, 'Not Found');
      return this.ok({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }

    if (method === 'POST' && rest === '/git/refs') {
      if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
      const ref = String(body.ref ?? '');
      const branch = ref.replace(/^refs\/heads\//, '');
      if (repo.refs.has(branch)) return this.fail(422, 'Reference already exists');
      if (!repo.commits.has(String(body.sha))) return this.fail(422, 'Object does not exist');
      repo.refs.set(branch, String(body.sha));
      return this.ok({ ref, object: { sha: body.sha } }, 201);
    }

    const headsMatch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (headsMatch) {
      const branch = decodeURIComponent(headsMatch[1]);
      if (method === 'DELETE') {
        if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
        if (repo.protectedBranches.has(branch)) {
          return this.fail(422, 'Cannot delete a protected branch');
        }
        if (!repo.refs.delete(branch)) return this.fail(422, 'Reference does not exist');
        return this.ok(null, 204);
      }
      if (method === 'PATCH') {
        if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
        if (repo.protectedBranches.has(branch)) {
          return this.fail(403, 'Protected branch update failed');
        }
        const current = repo.refs.get(branch);
        if (!current) return this.fail(422, 'Reference does not exist');
        const next = String(body.sha);
        if (!repo.commits.has(next)) return this.fail(422, 'Object does not exist');
        // The check that matters: without force, only a fast-forward is legal.
        if (!body.force && !repo.isAncestor(current, next)) {
          return this.fail(422, 'Update is not a fast forward');
        }
        repo.refs.set(branch, next);
        return this.ok({ ref: `refs/heads/${branch}`, object: { sha: next } });
      }
    }

    const commitMatch = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && commitMatch) {
      const commit = repo.commits.get(commitMatch[1]);
      if (!commit) return this.fail(404, 'Not Found');
      return this.ok({
        sha: commit.sha,
        message: commit.message,
        tree: { sha: commit.tree },
        parents: commit.parents.map((sha) => ({ sha })),
        author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      });
    }

    if (method === 'POST' && rest === '/git/commits') {
      if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
      if (!repo.trees.has(String(body.tree))) return this.fail(422, 'Tree does not exist');
      const parents = (body.parents as string[]) ?? [];
      for (const parent of parents) {
        if (!repo.commits.has(parent)) return this.fail(422, 'Parent does not exist');
      }
      const sha = repo.writeCommit({
        tree: String(body.tree),
        parents,
        message: String(body.message),
        author: body.author as { name: string; email: string } | undefined,
      });
      return this.ok({ sha }, 201);
    }

    const treeMatch = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && treeMatch) {
      const sha = treeMatch[1];
      if (!repo.trees.has(sha)) return this.fail(404, 'Not Found');
      const entries = query.recursive
        ? repo.readTree(sha)
        : (repo.trees.get(sha)!.entries.map((e) => ({
            path: e.name,
            sha: e.sha,
            type: e.type,
            mode: e.mode,
            size: 0,
          })));
      return this.ok({ sha, truncated: false, tree: entries });
    }

    if (method === 'POST' && rest === '/git/trees') {
      if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
      const baseTree = body.base_tree ? String(body.base_tree) : null;
      const files: Record<string, string> = {};
      if (baseTree) {
        if (!repo.trees.has(baseTree)) return this.fail(422, 'Base tree does not exist');
        for (const entry of repo.readTree(baseTree)) {
          if (entry.type === 'blob') files[entry.path] = repo.blobs.get(entry.sha) ?? '';
        }
      }
      for (const change of (body.tree as Array<{ path: string; sha: string | null }>) ?? []) {
        if (change.sha === null) {
          delete files[change.path];
          continue;
        }
        if (!repo.blobs.has(change.sha)) return this.fail(422, 'Blob does not exist');
        files[change.path] = repo.blobs.get(change.sha)!;
      }
      return this.ok({ sha: repo.writeTree(files) }, 201);
    }

    const blobMatch = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && blobMatch) {
      const content = repo.blobs.get(blobMatch[1]);
      if (content === undefined) return this.fail(404, 'Not Found');
      return this.ok({
        sha: blobMatch[1],
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      });
    }

    if (method === 'POST' && rest === '/git/blobs') {
      if (!repo.canPush) return this.fail(403, 'Resource not accessible by integration');
      const content = String(body.content ?? '');
      const sha = gitBlobSha(content);
      repo.blobs.set(sha, content);
      return this.ok({ sha }, 201);
    }

    return this.fail(404, 'Not Found');
  };
}
