/**
 * Shared domain types for Forge IDE.
 *
 * The file system is *path based*: a project owns a flat map of
 * `path -> content` for files and a set of directory paths. This mirrors how
 * real tooling (esbuild, git, zip archives) addresses files and avoids the
 * id/parent bookkeeping that makes tree mutations error prone.
 */

export type TemplateId =
  | 'blank'
  | 'vanilla'
  | 'react'
  | 'react-ts'
  | 'vite-ts'
  | 'node'
  | 'next';

export type ProjectVisibility = 'private' | 'team' | 'public';
export type ProjectStatus = 'draft' | 'active' | 'archived';

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  template: TemplateId;
  language: string;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
  ownerId: string;
}

/** A project plus its complete working tree. */
export interface Project extends ProjectMeta {
  files: Record<string, string>;
  /** Explicit directory entries so empty folders survive a round trip. */
  dirs: string[];
}

export type MemberRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  addedAt: number;
}

/**
 * A named grouping of projects, with the layout and preferences that go with
 * them. Workspaces are owned by one account; sharing happens per project.
 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  /** Projects belonging to this workspace, in the owner's chosen order. */
  projectIds: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last time the owner opened it, for the recent list. */
  openedAt: number;
}

/**
 * Application-level events worth showing on a timeline.
 *
 * Deliberately a closed set: an open string would let any caller write
 * anything into a record that is meant to be safe to persist server-side.
 */
export type ActivityAction =
  | 'project.created'
  | 'project.renamed'
  | 'project.archived'
  | 'project.restored'
  | 'project.visibility'
  | 'branch.created'
  | 'branch.switched'
  | 'branch.deleted'
  | 'commit.created'
  | 'remote.pushed'
  | 'remote.pulled'
  | 'build.completed'
  | 'agent.started'
  | 'agent.completed'
  | 'member.added'
  | 'member.removed'
  | 'member.role';

export interface ActivityEvent {
  id: string;
  projectId: string;
  actorId: string;
  actorName: string;
  action: ActivityAction;
  /** Short human-readable subject: a branch name, a commit summary, a path. */
  subject: string;
  createdAt: number;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** `local` means the session is a Local Development Mode account. */
  provider: 'local' | 'email' | 'google' | 'github';
}

export interface EditorTab {
  path: string;
  /** Pinned tabs survive "close others". */
  pinned: boolean;
}

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface Problem {
  id: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: ProblemSeverity;
  message: string;
  source: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  id: string;
  level: ConsoleLevel;
  /** `preview` = from the sandboxed iframe, `build` = bundler, `ide` = app. */
  channel: 'preview' | 'build' | 'ide';
  message: string;
  timestamp: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface PackageEntry {
  name: string;
  version: string;
  dev: boolean;
}

export interface RegistryPackage {
  name: string;
  version: string;
  description: string;
  publisher: string;
  date: string;
  links: { npm?: string; homepage?: string; repository?: string };
}

export type DevicepreSet = 'desktop' | 'tablet' | 'mobile';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: 'info' | 'success' | 'warning' | 'error';
  /** Optional retry affordance for failed operations. */
  action?: { label: string; run: () => void };
  duration: number;
}
