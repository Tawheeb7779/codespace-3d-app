import { create } from 'zustand';
import type { MemberRole, Project, ProjectMeta } from '@/types';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  ancestors,
  basename,
  dirname,
  isDescendant,
  isSensitivePath,
  joinPath,
  normalizePath,
  VfsError,
} from '@/lib/vfs';
import { detectProjectLanguage } from '@/lib/languages';
import { capabilitiesFor } from '@/lib/permissions';
import { errorMessage } from '@/lib/utils';

/**
 * The working tree for the open project.
 *
 * `files` is the live, in-memory state the editor and bundler read. Writes mark
 * paths dirty and schedule a persist; `flush` forces one (Ctrl+S, navigation,
 * tab close). Keeping persistence out of every keystroke is what makes typing
 * in a large project stay smooth.
 */

import { useSettingsStore } from '@/stores/settingsStore';

interface FileState {
  projectId: string | null;
  meta: ProjectMeta | null;
  files: Record<string, string>;
  dirs: string[];
  role: MemberRole;
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: number | null;
  dirty: Set<string>;

  open: (id: string) => Promise<void>;
  close: () => Promise<void>;
  writeFile: (path: string, content: string) => void;
  createFile: (path: string, content?: string) => string;
  createDir: (path: string) => string;
  rename: (from: string, to: string) => string;
  remove: (path: string) => void;
  duplicate: (path: string) => string;
  move: (from: string, toDir: string) => string;
  flush: () => Promise<void>;
  markAllClean: () => void;
  canWrite: () => boolean;
  assertWritable: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function repository() {
  return repositoryFor(useAuthStore.getState().user?.provider);
}

function scheduleSave() {
  const { autoSave, autoSaveDelay } = useSettingsStore.getState().editor;
  if (saveTimer) clearTimeout(saveTimer);
  // With auto-save off, edits stay dirty until an explicit save (Ctrl/Cmd+S),
  // a navigation away, or the tab being hidden.
  if (!autoSave) return;
  saveTimer = setTimeout(() => {
    void useFileStore.getState().flush();
  }, Math.max(200, autoSaveDelay));
}

/** Deriving the role locally mirrors what RLS enforces server side. */
function roleFor(project: Project): MemberRole {
  const user = useAuthStore.getState().user;
  if (user && project.ownerId === user.id) return 'owner';
  return 'viewer';
}

export const useFileStore = create<FileState>()((set, get) => ({
  projectId: null,
  meta: null,
  files: {},
  dirs: [],
  role: 'viewer',
  loading: false,
  saving: false,
  error: null,
  lastSavedAt: null,
  dirty: new Set(),

  async open(id) {
    if (get().projectId === id) return;
    await get().flush();
    set({ loading: true, error: null });
    try {
      const project = await repository().getProject(id);
      if (!project) throw new Error('This project does not exist, or you do not have access to it.');
      const { files, dirs, ...meta } = project;
      set({
        projectId: id,
        meta,
        files,
        dirs,
        role: roleFor(project),
        loading: false,
        dirty: new Set(),
        lastSavedAt: project.updatedAt,
      });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
      throw error;
    }
  },

  async close() {
    await get().flush();
    if (saveTimer) clearTimeout(saveTimer);
    set({ projectId: null, meta: null, files: {}, dirs: [], dirty: new Set(), error: null });
  },

  canWrite: () => capabilitiesFor(get().role).write,

  assertWritable() {
    if (!get().canWrite()) {
      throw new Error('You have read-only access to this project.');
    }
  },

  writeFile(path, content) {
    get().assertWritable();
    const safe = normalizePath(path);
    // Creation and rename both refuse a protected path; a plain write must too,
    // or a project-wide replace becomes a way to author into `.env` or `.git`.
    if (isSensitivePath(safe)) throw new VfsError(`"${safe}" is a protected path.`);
    set((state) => ({
      files: { ...state.files, [safe]: content },
      dirty: new Set(state.dirty).add(safe),
    }));
    scheduleSave();
  },

  createFile(path, content = '') {
    get().assertWritable();
    const safe = normalizePath(path);
    if (isSensitivePath(safe)) throw new VfsError(`"${safe}" is a protected path.`);
    if (safe in get().files) throw new VfsError(`${safe} already exists.`);
    set((state) => ({
      files: { ...state.files, [safe]: content },
      dirs: [...new Set([...state.dirs, ...ancestors(safe)])],
      dirty: new Set(state.dirty).add(safe),
    }));
    scheduleSave();
    return safe;
  },

  createDir(path) {
    get().assertWritable();
    const safe = normalizePath(path);
    if (get().dirs.includes(safe)) throw new VfsError(`${safe} already exists.`);
    set((state) => ({ dirs: [...new Set([...state.dirs, safe, ...ancestors(safe)])] }));
    scheduleSave();
    return safe;
  },

  rename(from, to) {
    get().assertWritable();
    const target = normalizePath(to.includes('/') ? to : joinPath(dirname(from), to));
    if (target === from) return from;
    if (isSensitivePath(target)) throw new VfsError(`"${target}" is a protected path.`);
    const { files, dirs } = get();
    if (target in files) throw new VfsError(`${target} already exists.`);

    const nextFiles: Record<string, string> = {};
    const dirtyPaths = new Set<string>();
    for (const [path, content] of Object.entries(files)) {
      if (path === from) {
        nextFiles[target] = content;
        dirtyPaths.add(target);
      } else if (isDescendant(path, from)) {
        const moved = target + path.slice(from.length);
        nextFiles[moved] = content;
        dirtyPaths.add(moved);
      } else {
        nextFiles[path] = content;
      }
    }
    const nextDirs = dirs.map((dir) =>
      dir === from || isDescendant(dir, from) ? target + dir.slice(from.length) : dir,
    );
    set((state) => ({
      files: nextFiles,
      dirs: [...new Set([...nextDirs, ...ancestors(target)])],
      dirty: new Set([...state.dirty, ...dirtyPaths]),
    }));
    scheduleSave();
    return target;
  },

  remove(path) {
    get().assertWritable();
    const safe = normalizePath(path);
    set((state) => {
      const files = { ...state.files };
      for (const key of Object.keys(files)) {
        if (key === safe || isDescendant(key, safe)) delete files[key];
      }
      return {
        files,
        dirs: state.dirs.filter((dir) => dir !== safe && !isDescendant(dir, safe)),
        dirty: new Set(state.dirty).add(safe),
      };
    });
    scheduleSave();
  },

  duplicate(path) {
    get().assertWritable();
    const safe = normalizePath(path);
    const content = get().files[safe];
    if (content === undefined) throw new VfsError(`${safe} is not a file.`);
    const dot = basename(safe).lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, safe.length - (basename(safe).length - dot)) : safe;
    const ext = dot > 0 ? basename(safe).slice(dot) : '';
    let candidate = `${stem} copy${ext}`;
    let counter = 2;
    while (candidate in get().files) {
      candidate = `${stem} copy ${counter++}${ext}`;
    }
    return get().createFile(candidate, content);
  },

  move(from, toDir) {
    const target = toDir ? joinPath(normalizePath(toDir), basename(from)) : basename(from);
    return get().rename(from, target);
  },

  markAllClean: () => set({ dirty: new Set() }),

  async flush() {
    const { projectId, files, dirs, dirty, meta } = get();
    if (!projectId || !dirty.size) return;
    if (!get().canWrite()) {
      set({ dirty: new Set() });
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    set({ saving: true, error: null });
    try {
      await repository().saveFiles(projectId, files, dirs);
      const language = detectProjectLanguage(Object.keys(files));
      if (meta && meta.language !== language) {
        await repository().updateProject(projectId, { language });
        set({ meta: { ...meta, language } });
      }
      const updatedAt = Date.now();
      set({ dirty: new Set(), saving: false, lastSavedAt: updatedAt });
      useProjectStore.getState().upsertLocal({
        ...(get().meta as ProjectMeta),
        updatedAt,
      });
    } catch (error) {
      // Keep the dirty set so the next flush retries the same work.
      set({ saving: false, error: errorMessage(error) });
      throw error;
    }
  },
}));

/** Persist pending edits when the tab goes away. */
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void useFileStore.getState().flush();
  });
}
