/**
 * Shapes Forge consumes from the GitHub REST API.
 *
 * Only the fields the IDE actually uses are modelled. GitHub returns a great
 * deal more; narrowing here keeps the surface small and makes it obvious what
 * a proxy would have to forward.
 */

export interface GithubAccount {
  login: string;
  id: number;
  avatarUrl: string | null;
  name: string | null;
}

export interface GithubRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  updatedAt: string;
  /** Whether the connected identity may write to this repository. */
  canPush: boolean;
  /** Repositories with no commits yet need a different first push. */
  empty: boolean;
}

export interface GithubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GithubCommitRef {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** A page of results plus the cursor needed to ask for the next one. */
export interface Page<T> {
  items: T[];
  page: number;
  hasNextPage: boolean;
}

/** Remaining request budget, surfaced so the UI can explain a 403. */
export interface RateLimit {
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  resetAt: number;
}

/** A file in a fetched tree. `null` content means the blob was not text. */
export interface RemoteFile {
  path: string;
  content: string | null;
  sha: string;
  size: number;
}

export interface RemoteTree {
  /** Commit the tree was read from. */
  commitSha: string;
  treeSha: string;
  files: RemoteFile[];
  /** GitHub stops at 100k entries; a truncated tree cannot be trusted. */
  truncated: boolean;
  /** Entries skipped because they are not text Forge can hold. */
  skipped: Array<{ path: string; reason: string }>;
}
