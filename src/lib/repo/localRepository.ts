import { idbAll, idbDelete, idbGet, idbSet } from '@/lib/idb';
import type { Project, ProjectMeta } from '@/types';
import type { Repo } from '@/lib/vcs';
import type { ProjectRepository } from '@/lib/repo/types';

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
  },

  async loadVcs(id) {
    return (await idbGet<Repo>('repos', id)) ?? null;
  },

  async saveVcs(id, repo) {
    await idbSet('repos', id, repo);
  },
};
