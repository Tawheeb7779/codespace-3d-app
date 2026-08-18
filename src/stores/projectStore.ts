import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Project, ProjectFile, ProjectTemplate, SceneObject } from '@/types';
import { createTemplateFiles } from '@/lib/templates';

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  createProject: (name: string, description: string, template: ProjectTemplate) => string;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  getActiveProject: () => Project | null;
  addFile: (projectId: string, file: Omit<ProjectFile, 'id'>) => string;
  updateFile: (projectId: string, fileId: string, updates: Partial<ProjectFile>) => void;
  deleteFile: (projectId: string, fileId: string) => void;
  renameFile: (projectId: string, fileId: string, name: string) => void;
  addSceneObject: (projectId: string, obj: Omit<SceneObject, 'id'>) => void;
  updateSceneObject: (projectId: string, objId: string, updates: Partial<SceneObject>) => void;
  deleteSceneObject: (projectId: string, objId: string) => void;
}

let idCounter = 0;
const genId = (prefix: string) => `${prefix}_${Date.now()}_${idCounter++}`;

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,

      createProject: (name, description, template) => {
        const id = genId('proj');
        const now = Date.now();
        const files = createTemplateFiles(template);
        const project: Project = {
          id,
          name,
          description,
          template,
          createdAt: now,
          updatedAt: now,
          files,
          sceneObjects: template === 'threejs' || template === 'react-three'
            ? [
                {
                  id: genId('obj'),
                  name: 'Cube',
                  type: 'box',
                  position: [0, 0, 0],
                  rotation: [0, 0, 0],
                  scale: [1, 1, 1],
                  color: '#4d8eff',
                  metalness: 0.3,
                  roughness: 0.5,
                  visible: true,
                },
              ]
            : [],
        };
        set((state) => ({ projects: [...state.projects, project] }));
        return id;
      },

      deleteProject: (id) =>
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
        })),

      setActiveProject: (id) => set({ activeProjectId: id }),

      updateProject: (id, updates) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
          ),
        })),

      getActiveProject: () => {
        const { projects, activeProjectId } = get();
        return projects.find((p) => p.id === activeProjectId) ?? null;
      },

      addFile: (projectId, file) => {
        const fileId = genId('file');
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p;
            const newFile: ProjectFile = { ...file, id: fileId };
            const files = [...p.files, newFile];
            if (file.parentId) {
              return {
                ...p,
                files: files.map((f) =>
                  f.id === file.parentId
                    ? { ...f, children: [...(f.children ?? []), fileId] }
                    : f
                ),
                updatedAt: Date.now(),
              };
            }
            return { ...p, files, updatedAt: Date.now() };
          }),
        }));
        return fileId;
      },

      updateFile: (projectId, fileId, updates) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  files: p.files.map((f) =>
                    f.id === fileId ? { ...f, ...updates } : f
                  ),
                  updatedAt: Date.now(),
                }
          ),
        })),

      deleteFile: (projectId, fileId) =>
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p;
            const file = p.files.find((f) => f.id === fileId);
            if (!file) return p;
            const toRemove = new Set<string>([fileId]);
            const collectChildren = (id: string) => {
              p.files.forEach((f) => {
                if (f.parentId === id) {
                  toRemove.add(f.id);
                  collectChildren(f.id);
                }
              });
            };
            collectChildren(fileId);
            return {
              ...p,
              files: p.files
                .filter((f) => !toRemove.has(f.id))
                .map((f) =>
                  f.children
                    ? { ...f, children: f.children.filter((c) => !toRemove.has(c)) }
                    : f
                ),
              updatedAt: Date.now(),
            };
          }),
        })),

      renameFile: (projectId, fileId, name) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  files: p.files.map((f) =>
                    f.id === fileId ? { ...f, name } : f
                  ),
                  updatedAt: Date.now(),
                }
          ),
        })),

      addSceneObject: (projectId, obj) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  sceneObjects: [...(p.sceneObjects ?? []), { ...obj, id: genId('obj') }],
                  updatedAt: Date.now(),
                }
          ),
        })),

      updateSceneObject: (projectId, objId, updates) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  sceneObjects: (p.sceneObjects ?? []).map((o) =>
                    o.id === objId ? { ...o, ...updates } : o
                  ),
                  updatedAt: Date.now(),
                }
          ),
        })),

      deleteSceneObject: (projectId, objId) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  sceneObjects: (p.sceneObjects ?? []).filter((o) => o.id !== objId),
                  updatedAt: Date.now(),
                }
          ),
        })),
    }),
    { name: 'codespace-projects' }
  )
);
