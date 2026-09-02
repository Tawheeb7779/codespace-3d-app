import { GithubError, errorFromResponse } from '@/lib/github/errors';
import {
  assertBranchName,
  assertOwner,
  assertRepoName,
  assertSha,
  type RepoSpec,
} from '@/lib/github/identifiers';
import type {
  GithubAccount,
  GithubBranch,
  GithubCommitRef,
  GithubRepo,
  Page,
  RateLimit,
  RemoteFile,
  RemoteTree,
} from '@/lib/github/types';
import { isSensitivePath, isTextFile, normalizePath } from '@/lib/vfs';

/**
 * A typed GitHub REST client built on the Git Data API.
 *
 * Every write goes through real git objects — blobs, trees, commits, refs — so
 * a push produces the same history a `git push` would, and GitHub itself is
 * what decides whether a ref update is a fast-forward. Nothing here simulates
 * a result: if GitHub does not answer 2xx, the call throws.
 *
 * The client never holds a credential. It issues abstract requests and a
 * transport attaches authentication, which is what lets the same code run
 * against a server-side proxy (production) or a session-scoped token
 * (local development) without changing a line of Git logic.
 */

export interface GithubRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path below the API root, already validated and encoded. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface GithubResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: unknown;
}

export type GithubTransport = (request: GithubRequest) => Promise<GithubResponse>;

/** Largest single file Forge will pull out of a repository, matching the VFS cap. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Guard against importing a monorepo that would wedge the browser. */
export const MAX_TREE_FILES = 3000;
/** Commits walked when reporting incoming changes. */
export const MAX_LISTED_COMMITS = 50;

const EMPTY_HEADERS = { get: () => null };

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a GitHub blob, returning null when it is not valid UTF-8 text. */
export function decodeBlob(content: string, encoding: string): string | null {
  if (encoding === 'utf-8') return content;
  if (encoding !== 'base64') return null;
  try {
    const bytes = decodeBase64(content);
    // A NUL byte is the cheap, reliable binary signal git itself uses.
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface RestRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  updated_at: string;
  pushed_at?: string | null;
  size?: number;
  owner: { login: string };
  permissions?: { push?: boolean; admin?: boolean };
}

function toRepo(raw: RestRepo): GithubRepo {
  return {
    id: raw.id,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch || 'main',
    description: raw.description ?? '',
    updatedAt: raw.pushed_at || raw.updated_at,
    canPush: Boolean(raw.permissions?.push ?? raw.permissions?.admin),
    // GitHub reports a repository with no commits as size 0 and pushed_at null.
    empty: raw.pushed_at === null,
  };
}

export class GithubClient {
  constructor(private readonly transport: GithubTransport) {}

  private async send(request: GithubRequest): Promise<GithubResponse> {
    let response: GithubResponse;
    try {
      response = await this.transport(request);
    } catch (error) {
      if (error instanceof GithubError) throw error;
      throw new GithubError(
        'network',
        'Could not reach GitHub. Check your connection and try again.',
      );
    }
    if (response.status >= 200 && response.status < 300) return response;
    throw errorFromResponse(response.status, response.headers ?? EMPTY_HEADERS, response.body);
  }

  private async json<T>(request: GithubRequest): Promise<T> {
    return (await this.send(request)).body as T;
  }

  // --- identity ----------------------------------------------------------

  async viewer(): Promise<GithubAccount> {
    const raw = await this.json<{ login: string; id: number; avatar_url: string; name: string | null }>(
      { method: 'GET', path: '/user' },
    );
    return { login: raw.login, id: raw.id, avatarUrl: raw.avatar_url ?? null, name: raw.name ?? null };
  }

  async rateLimit(): Promise<RateLimit> {
    const raw = await this.json<{ rate: { limit: number; remaining: number; reset: number } }>({
      method: 'GET',
      path: '/rate_limit',
    });
    return { limit: raw.rate.limit, remaining: raw.rate.remaining, resetAt: raw.rate.reset };
  }

  // --- repositories ------------------------------------------------------

  /** Repositories the connected identity can see, newest activity first. */
  async listRepos(page = 1, perPage = 30): Promise<Page<GithubRepo>> {
    const size = Math.min(Math.max(perPage, 1), 100);
    const raw = await this.json<RestRepo[]>({
      method: 'GET',
      path: '/user/repos',
      query: { per_page: size, page, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
    });
    return { items: raw.map(toRepo), page, hasNextPage: raw.length === size };
  }

  /**
   * Search restricted to repositories the viewer can reach. GitHub's search
   * index only returns what the credential may see, so this cannot be used to
   * probe for private repositories the user has no access to.
   */
  async searchRepos(query: string, page = 1, perPage = 30): Promise<Page<GithubRepo>> {
    const term = query.trim();
    if (!term) return this.listRepos(page, perPage);
    const size = Math.min(Math.max(perPage, 1), 100);
    const raw = await this.json<{ items: RestRepo[]; total_count: number }>({
      method: 'GET',
      path: '/search/repositories',
      query: { q: `${term} fork:true`, per_page: size, page },
    });
    return {
      items: raw.items.map(toRepo),
      page,
      hasNextPage: page * size < Math.min(raw.total_count, 1000),
    };
  }

  async getRepo({ owner, repo }: RepoSpec): Promise<GithubRepo> {
    return toRepo(
      await this.json<RestRepo>({
        method: 'GET',
        path: `/repos/${assertOwner(owner)}/${assertRepoName(repo)}`,
      }),
    );
  }

  async createRepo(input: {
    name: string;
    description?: string;
    private: boolean;
    autoInit?: boolean;
  }): Promise<GithubRepo> {
    return toRepo(
      await this.json<RestRepo>({
        method: 'POST',
        path: '/user/repos',
        body: {
          name: assertRepoName(input.name),
          description: (input.description ?? '').slice(0, 350),
          private: input.private,
          auto_init: Boolean(input.autoInit),
        },
      }),
    );
  }

  // --- branches ----------------------------------------------------------

  async listBranches({ owner, repo }: RepoSpec, page = 1, perPage = 100): Promise<Page<GithubBranch>> {
    const size = Math.min(Math.max(perPage, 1), 100);
    const raw = await this.json<Array<{ name: string; commit: { sha: string }; protected: boolean }>>({
      method: 'GET',
      path: `/repos/${assertOwner(owner)}/${assertRepoName(repo)}/branches`,
      query: { per_page: size, page },
    });
    return {
      items: raw.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })),
      page,
      hasNextPage: raw.length === size,
    };
  }

  /**
   * Tip of a branch, or null when the branch does not exist yet.
   *
   * GitHub answers 404 both for "this branch has no commits" and for "this
   * repository is gone", and those need opposite responses: the first is the
   * normal start of a first push, the second must stop everything. So a 404
   * here is re-checked against the repository itself before it is treated as
   * an empty branch.
   */
  async branchTip(spec: RepoSpec, branch: string): Promise<string | null> {
    const path = `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/ref/heads/${encodeURIComponent(
      assertBranchName(branch),
    )}`;
    try {
      const raw = await this.json<{ object: { sha: string } }>({ method: 'GET', path });
      return assertSha(raw.object.sha);
    } catch (error) {
      if (!(error instanceof GithubError) || error.kind !== 'not-found') throw error;
      await this.getRepo(spec); // Throws not-found if the repository is gone.
      return null;
    }
  }

  async createBranch(spec: RepoSpec, branch: string, sha: string): Promise<void> {
    await this.send({
      method: 'POST',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/refs`,
      body: { ref: `refs/heads/${assertBranchName(branch)}`, sha: assertSha(sha) },
    });
  }

  async deleteBranch(spec: RepoSpec, branch: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/refs/heads/${encodeURIComponent(
        assertBranchName(branch),
      )}`,
    });
  }

  /**
   * Move a branch. `force` stays false so **GitHub** performs the
   * fast-forward check; Forge never decides on its own that an overwrite is
   * safe, and a rejected update comes back as a 422 we surface verbatim.
   */
  async updateBranch(spec: RepoSpec, branch: string, sha: string): Promise<void> {
    await this.send({
      method: 'PATCH',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/refs/heads/${encodeURIComponent(
        assertBranchName(branch),
      )}`,
      body: { sha: assertSha(sha), force: false },
    });
  }

  // --- reading history and trees ----------------------------------------

  async commit(spec: RepoSpec, sha: string): Promise<GithubCommitRef & { treeSha: string; parents: string[] }> {
    const raw = await this.json<{
      sha: string;
      message: string;
      tree: { sha: string };
      parents: Array<{ sha: string }>;
      author: { name: string; date: string };
    }>({
      method: 'GET',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/commits/${assertSha(sha)}`,
    });
    return {
      sha: raw.sha,
      message: raw.message,
      author: raw.author?.name ?? 'unknown',
      date: raw.author?.date ?? '',
      treeSha: raw.tree.sha,
      parents: raw.parents.map((p) => p.sha),
    };
  }

  /** Commits reachable from `sha`, newest first. Used for "incoming". */
  async listCommits(spec: RepoSpec, sha: string, limit = MAX_LISTED_COMMITS): Promise<GithubCommitRef[]> {
    const raw = await this.json<
      Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>
    >({
      method: 'GET',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/commits`,
      query: { sha: assertSha(sha), per_page: Math.min(limit, 100) },
    });
    return raw.slice(0, limit).map((entry) => ({
      sha: entry.sha,
      message: entry.commit.message,
      author: entry.commit.author?.name ?? 'unknown',
      date: entry.commit.author?.date ?? '',
    }));
  }

  /**
   * Read a whole commit into a Forge working tree.
   *
   * Every path is put through the shared VFS validator, so a repository that
   * contains `../escape` or `.git/config` cannot place a file outside the
   * project or over a protected path — the entry is skipped and reported.
   */
  async readTree(spec: RepoSpec, commitSha: string): Promise<RemoteTree> {
    const head = await this.commit(spec, commitSha);
    const raw = await this.json<{
      sha: string;
      truncated: boolean;
      tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
    }>({
      method: 'GET',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/trees/${assertSha(head.treeSha)}`,
      query: { recursive: '1' },
    });

    const skipped: RemoteTree['skipped'] = [];
    const wanted: Array<{ path: string; sha: string; size: number }> = [];

    for (const entry of raw.tree) {
      if (entry.type !== 'blob') continue;
      if (entry.mode === '120000') {
        skipped.push({ path: entry.path, reason: 'symbolic link' });
        continue;
      }
      if (entry.mode === '160000') {
        skipped.push({ path: entry.path, reason: 'submodule' });
        continue;
      }
      let path: string;
      try {
        path = normalizePath(entry.path);
      } catch {
        skipped.push({ path: entry.path, reason: 'unsafe path' });
        continue;
      }
      if (isSensitivePath(path)) {
        skipped.push({ path, reason: 'protected path' });
        continue;
      }
      if (!isTextFile(path)) {
        skipped.push({ path, reason: 'binary or unsupported type' });
        continue;
      }
      if ((entry.size ?? 0) > MAX_FILE_BYTES) {
        skipped.push({ path, reason: 'over the 2 MB file limit' });
        continue;
      }
      if (wanted.length >= MAX_TREE_FILES) {
        skipped.push({ path, reason: `over the ${MAX_TREE_FILES} file limit` });
        continue;
      }
      wanted.push({ path, sha: entry.sha, size: entry.size ?? 0 });
    }

    const files: RemoteFile[] = [];
    for (const entry of wanted) {
      const blob = await this.json<{ content: string; encoding: string }>({
        method: 'GET',
        path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/blobs/${assertSha(entry.sha)}`,
      });
      const content = decodeBlob(blob.content, blob.encoding);
      if (content === null) {
        skipped.push({ path: entry.path, reason: 'not UTF-8 text' });
        continue;
      }
      files.push({ path: entry.path, content, sha: entry.sha, size: entry.size });
    }

    return { commitSha: head.sha, treeSha: head.treeSha, files, truncated: raw.truncated, skipped };
  }

  // --- writing -----------------------------------------------------------

  async createBlob(spec: RepoSpec, content: string): Promise<string> {
    const raw = await this.json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/blobs`,
      body: { content, encoding: 'utf-8' },
    });
    return assertSha(raw.sha);
  }

  /**
   * Build a tree from a base plus a set of changes. Deletions are expressed
   * the way the Git Data API expects them: an entry whose sha is null.
   */
  async createTree(
    spec: RepoSpec,
    baseTree: string | null,
    changes: Array<{ path: string; sha: string | null }>,
  ): Promise<string> {
    const raw = await this.json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/trees`,
      body: {
        ...(baseTree ? { base_tree: assertSha(baseTree) } : {}),
        tree: changes.map((change) => ({
          path: normalizePath(change.path),
          mode: '100644',
          type: 'blob',
          sha: change.sha === null ? null : assertSha(change.sha),
        })),
      },
    });
    return assertSha(raw.sha);
  }

  async createCommit(
    spec: RepoSpec,
    input: { message: string; tree: string; parents: string[]; author?: { name: string; email: string } },
  ): Promise<string> {
    const raw = await this.json<{ sha: string }>({
      method: 'POST',
      path: `/repos/${assertOwner(spec.owner)}/${assertRepoName(spec.repo)}/git/commits`,
      body: {
        message: input.message,
        tree: assertSha(input.tree),
        parents: input.parents.map(assertSha),
        ...(input.author ? { author: input.author } : {}),
      },
    });
    return assertSha(raw.sha);
  }
}
