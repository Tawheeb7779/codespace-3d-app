import { idbAll, idbDelete, idbGet, idbSet } from '@/lib/idb';
import type {
  ActivityEvent,
  Project,
  ProjectMember,
  ProjectMeta,
  Workspace,
} from '@/types';
import type { Repo } from '@/lib/vcs';
import type { ProjectRepository } from '@/lib/repo/types';
import type { RemoteRef } from '@/lib/github/remote';

const toMeta = (project: Project): ProjectMeta => {
  const { files: _files, dirs: _dirs, ...meta } = project;
  return meta;
};

export const localRepository: ProjectRepository = {
  kind: 'local',

  async listProjects(ownerId) {
    const all = await idbAll<Project>('projects');
    return all
      .filter((p) => p.ownerId === ownerId)
      .map(toMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getProject(id) {
    return (await idbGet<Project>('projects', id)) ?? null;
  },

  async createProject(project) {
    await idbSet('projects', project.id, project);
    return project;
  },

  async updateProject(id, patch) {
    const existing = await idbGet<Project>('projects', id);
    if (!existing) throw new Error(`Project ${id} no longer exists`);
    await idbSet('projects', id, { ...existing, ...patch, updatedAt: Date.now() });
  },

  async saveFiles(id, files, dirs) {
    const existing = await idbGet<Project>('projects', id);
    if (!existing) throw new Error(`Project ${id} no longer exists`);
    await idbSet('projects', id, { ...existing, files, dirs, updatedAt: Date.now() });
  },

  async deleteProject(id) {
    await idbDelete('projects', id);
    await idbDelete('repos', id);
    await idbDelete('kv', `remote:${id}`);
  },

  async loadVcs(id) {
    return (await idbGet<Repo>('repos', id)) ?? null;
  },

  async saveVcs(id, repo) {
    await idbSet('repos', id, repo);
  },

  async loadRemote(id) {
    return (await idbGet<RemoteRef>('kv', `remote:${id}`)) ?? null;
  },

  async saveRemote(id, remote) {
    await idbSet('kv', `remote:${id}`, remote);
  },

  async clearRemote(id) {
    await idbDelete('kv', `remote:${id}`);
  },

  // -- Membership -----------------------------------------------------------
  //
  // Local Development Mode has exactly one account, so the only membership
  // that exists is the owner's own. Storing it anyway keeps this backend
  // answering the same questions as the cloud one, which is what lets the
  // stores stay free of `if (local)` branches.

  async listMembers(projectId) {
    const all = await idbAll<ProjectMember>('members');
    return all
      .filter((member) => member.projectId === projectId)
      .sort((a, b) => a.addedAt - b.addedAt);
  },

  async roleFor(projectId, userId) {
    const project = await idbGet<Project>('projects', projectId);
    if (!project) return null;
    if (project.ownerId === userId) return 'owner';
    const all = await idbAll<ProjectMember>('members');
    const member = all.find((m) => m.projectId === projectId && m.userId === userId);
    return member?.role ?? null;
  },

  async addMember(member) {
    await idbSet('members', `${member.projectId}:${member.userId}`, member);
    return member;
  },

  async setMemberRole(projectId, userId, role) {
    const key = `${projectId}:${userId}`;
    const existing = await idbGet<ProjectMember>('members', key);
    if (!existing) throw new Error('That person is not a member of this project.');
    await idbSet('members', key, { ...existing, role });
  },

  async removeMember(projectId, userId) {
    await idbDelete('members', `${projectId}:${userId}`);
  },

  // -- Invitations ----------------------------------------------------------
  //
  // Local Development Mode has exactly one account, so there is nobody to
  // invite and no second session that could redeem a token. These refuse
  // rather than storing a record that could never be acted on.

  async listInvitations() {
    return [];
  },

  async createInvitation() {
    throw new Error(
      'Inviting people needs a Supabase project. Local Development Mode has a single account.',
    );
  },

  async revokeInvitation() {
    throw new Error('There are no invitations in Local Development Mode.');
  },

  async acceptInvitation() {
    throw new Error('Invitations can only be accepted when signed in to a Supabase project.');
  },

  // -- Activity -------------------------------------------------------------

  async listActivity(projectId, limit) {
    const all = await idbAll<ActivityEvent>('activity');
    return all
      .filter((event) => event.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },

  async recordActivity(event) {
    await idbSet('activity', event.id, event);
  },

  // -- Workspaces -----------------------------------------------------------

  async listWorkspaces(ownerId) {
    const all = await idbAll<Workspace>('workspaces');
    return all
      .filter((workspace) => workspace.ownerId === ownerId)
      .sort((a, b) => b.openedAt - a.openedAt);
  },

  async saveWorkspace(workspace) {
    await idbSet('workspaces', workspace.id, workspace);
  },

  async deleteWorkspace(id) {
    await idbDelete('workspaces', id);
  },
};
