import type {
  ActivityEvent,
  MemberRole,
  Project,
  ProjectMember,
  ProjectMeta,
  Workspace,
} from '@/types';
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

  // -- Membership -----------------------------------------------------------
  //
  // The role returned here is what the client renders affordances from. It is
  // never the security boundary: the same rule is enforced by row level
  // security in `supabase/migrations`, which is what actually stops a write.

  listMembers(projectId: string): Promise<ProjectMember[]>;
  /** The caller's role on a project, or null when they are not a member. */
  roleFor(projectId: string, userId: string): Promise<MemberRole | null>;
  addMember(member: ProjectMember): Promise<ProjectMember>;
  setMemberRole(projectId: string, userId: string, role: MemberRole): Promise<void>;
  removeMember(projectId: string, userId: string): Promise<void>;

  // -- Activity -------------------------------------------------------------

  listActivity(projectId: string, limit: number): Promise<ActivityEvent[]>;
  recordActivity(event: ActivityEvent): Promise<void>;

  // -- Workspaces -----------------------------------------------------------

  listWorkspaces(ownerId: string): Promise<Workspace[]>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
}
