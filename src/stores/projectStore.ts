import { create } from 'zustand';
import type { Project, ProjectMeta, TemplateId } from '@/types';
import { getTemplate } from '@/lib/templates';
import { detectProjectLanguage } from '@/lib/languages';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { recordActivity } from '@/stores/activityStore';
import { useFileStore } from '@/stores/fileStore';
import { errorMessage, uid } from '@/lib/utils';

interface ProjectState {
  projects: ProjectMeta[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (input: {
    name: string;
    description?: string;
    template: TemplateId;
    files?: Record<string, string>;
    dirs?: string[];
  }) => Promise<Project>;
  rename: (id: string, name: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;
  setStatus: (id: string, status: ProjectMeta['status']) => Promise<void>;
  setVisibility: (id: string, visibility: ProjectMeta['visibility']) => Promise<void>;
  duplicate: (id: string) => Promise<Project>;
  remove: (id: string) => Promise<void>;
  upsertLocal: (meta: ProjectMeta) => void;
}

function currentUser() {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('You must be signed in to manage projects.');
  return user;
}

function repository() {
  return repositoryFor(useAuthStore.getState().user?.provider);
}

export function validateProjectName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 1) throw new Error('Project name cannot be empty.');
  if (clean.length > 60) throw new Error('Project name must be 60 characters or fewer.');
  return clean;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  projects: [],
  loading: false,
  error: null,

  async load() {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ projects: [], loading: false });
      return;
    }
    set({ loading: true, error: null });
    try {
      const projects = await repository().listProjects(user.id);
      set({ projects, loading: false });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async create({ name, description = '', template, files, dirs }) {
    const user = currentUser();
    const clean = validateProjectName(name);
    const blueprint = getTemplate(template);
    const projectFiles = files ?? { ...blueprint.files };
    const projectDirs = dirs ?? [...(blueprint.dirs ?? [])];
    const now = Date.now();
    const project: Project = {
      id: uid('prj'),
      name: clean,
      description: description.trim().slice(0, 280),
      template,
      language: detectProjectLanguage(Object.keys(projectFiles)),
      visibility: 'private',
      status: 'active',
      starred: false,
      createdAt: now,
      updatedAt: now,
      ownerId: user.id,
      files: projectFiles,
      dirs: projectDirs,
    };
    const created = await repository().createProject(project);
    const { files: _f, dirs: _d, ...meta } = created;
    set((state) => ({ projects: [meta, ...state.projects] }));
    return created;
  },

  async rename(id, name) {
    const clean = validateProjectName(name);
    await repository().updateProject(id, { name: clean });
    recordActivity('project.renamed', clean);
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, name: clean, updatedAt: Date.now() } : p,
      ),
    }));
  },

  async toggleStar(id) {
    const project = get().projects.find((p) => p.id === id);
    if (!project) throw new Error('That project no longer exists.');
    const starred = !project.starred;
    // Optimistic: the star is trivially reversible and must feel instant.
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, starred } : p)),
    }));
    try {
      await repository().updateProject(id, { starred });
    } catch (error) {
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? { ...p, starred: !starred } : p)),
      }));
      throw error;
    }
  },

  async setStatus(id, status) {
    await repository().updateProject(id, { status });
    recordActivity(status === 'archived' ? 'project.archived' : 'project.restored');
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, status } : p)),
    }));
  },

  async setVisibility(id, visibility) {
    await repository().updateProject(id, { visibility });
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, visibility } : p)),
    }));
    // Keep the open project's own copy of the metadata in step.
    const fileStore = useFileStore.getState();
    if (fileStore.projectId === id && fileStore.meta) {
      useFileStore.setState({ meta: { ...fileStore.meta, visibility } });
    }
    recordActivity('project.visibility', visibility);
  },

  async duplicate(id) {
    const source = await repository().getProject(id);
    if (!source) throw new Error('That project no longer exists.');
    return get().create({
      name: `${source.name} copy`,
      description: source.description,
      template: source.template,
      files: { ...source.files },
      dirs: [...source.dirs],
    });
  },

  async remove(id) {
    await repository().deleteProject(id);
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }));
  },

  upsertLocal: (meta) =>
    set((state) => ({
      projects: state.projects.some((p) => p.id === meta.id)
        ? state.projects.map((p) => (p.id === meta.id ? meta : p))
        : [meta, ...state.projects],
    })),
}));
