import type { Project, ProjectMeta } from '@/types';
import type { Repo } from '@/lib/vcs';
import type { RemoteRef } from '@/lib/github/remote';

/**
 * Storage boundary for projects. Two implementations exist:
 *
 * - `localRepository` — IndexedDB, always available, used in Local Development
 *   Mode and as the offline path.
 * - `supabaseRepository` — Postgres behind row level security, used when the
 *   app is configured and a user is signed in.
 *
 * Both are addressed through the same interface so the stores never branch on
 * which backend is active.
 */
export interface ProjectRepository {
  readonly kind: 'local' | 'supabase';
  listProjects(ownerId: string): Promise<ProjectMeta[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(project: Project): Promise<Project>;
  updateProject(id: string, patch: Partial<ProjectMeta>): Promise<void>;
  /** Replace the whole working tree for a project. */
  saveFiles(id: string, files: Record<string, string>, dirs: string[]): Promise<void>;
  deleteProject(id: string): Promise<void>;
  loadVcs(id: string): Promise<Repo | null>;
  saveVcs(id: string, repo: Repo): Promise<void>;
  /** The GitHub repository this project tracks, if any. */
  loadRemote(id: string): Promise<RemoteRef | null>;
  saveRemote(id: string, remote: RemoteRef): Promise<void>;
  clearRemote(id: string): Promise<void>;
}
