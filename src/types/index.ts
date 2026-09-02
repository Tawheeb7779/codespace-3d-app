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
