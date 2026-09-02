/**
 * Validation for every GitHub identifier Forge puts into a URL path.
 *
 * These run before a request is built, on the client and again inside the
 * server proxy. An owner or repository name is interpolated straight into an
 * API path, so an unvalidated one is a path-traversal primitive against the
 * GitHub API itself: `owner = "../../user"` would turn a repository read into
 * a call the user never asked for.
 */

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierError';
  }
}

/** GitHub logins: alphanumeric and hyphens, no leading/trailing hyphen, ≤39. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** Repository names: alphanumeric plus `.`, `_`, `-`; ≤100. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function assertOwner(owner: unknown): string {
  if (typeof owner !== 'string' || !OWNER.test(owner)) {
    throw new IdentifierError(`Invalid GitHub owner: ${String(owner).slice(0, 60)}`);
  }
  return owner;
}

export function assertRepoName(repo: unknown): string {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new IdentifierError(`Invalid GitHub repository name: ${String(repo).slice(0, 60)}`);
  }
  return repo;
}

/**
 * git's own rules, trimmed to what GitHub accepts (see `git check-ref-format`).
 * The dangerous cases are `..` (traversal once interpolated) and a leading `-`
 * (an option, if the name ever reaches a command line).
 */
export function assertBranchName(branch: unknown): string {
  if (typeof branch !== 'string' || !branch.length || branch.length > 255) {
    throw new IdentifierError(`Invalid branch name: ${String(branch).slice(0, 60)}`);
  }
  const invalid =
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch.includes('\\') ||
    // Control characters and space are exactly what git forbids in a ref, so
    // the range is deliberate rather than an accident.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x20~^:?*[\]]/.test(branch) ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch === '@';
  if (invalid) throw new IdentifierError(`Invalid branch name: ${branch.slice(0, 60)}`);
  return branch;
}

/** A 40-character git object name. */
export function assertSha(sha: unknown): string {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new IdentifierError(`Invalid git object id: ${String(sha).slice(0, 60)}`);
  }
  return sha;
}

export interface RepoSpec {
  owner: string;
  repo: string;
}

/**
 * Accept the forms a developer will paste: `owner/name`, a browser URL, an
 * SSH remote, a `.git` clone URL. Anything else is rejected rather than
 * guessed at.
 */
export function parseRepoSpec(input: string): RepoSpec {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (!trimmed) throw new IdentifierError('Enter a repository.');

  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:[?#].*)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) return { owner: assertOwner(match[1]), repo: assertRepoName(match[2]) };
  }
  throw new IdentifierError('Enter a repository as owner/name or a GitHub URL.');
}
