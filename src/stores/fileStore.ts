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
/** Tail of the serialised save queue. Never rejects; see `flush`. */
let saveChain: Promise<void> = Promise.resolve();

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
    // Nobody is awaiting an auto-save, so its failure has to be absorbed here:
    // the store already carries the message, and an unhandled rejection would
    // otherwise be the only trace of it.
    void useFileStore.getState().flush().catch(() => undefined);
  }, Math.max(200, autoSaveDelay));
}

/**
 * The caller's role on a project.
 *
 * Owning it settles the question without a lookup; otherwise the membership
 * record decides, and a project with no record for this user is read-only.
 * This mirrors what row level security enforces server side — it renders the
 * right affordances, it is not the boundary.
 */
async function resolveRole(project: Project): Promise<MemberRole> {
  const user = useAuthStore.getState().user;
  if (!user) return 'viewer';
  if (project.ownerId === user.id) return 'owner';
  try {
    return (await repository().roleFor(project.id, user.id)) ?? 'viewer';
  } catch {
    // A membership lookup that fails must not hand out more access than the
    // caller has: fall back to the least privileged role.
    return 'viewer';
  }
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
      const role = await resolveRole(project);
      set({
        projectId: id,
        meta,
        files,
        dirs,
        role,
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
    // The new directory has to enter the dirty set even though it holds no
    // file. `flush` returns early on an empty set, so without this an empty
    // folder lived in memory and vanished on the next reload.
    set((state) => ({
      dirs: [...new Set([...state.dirs, safe, ...ancestors(safe)])],
      dirty: new Set(state.dirty).add(safe),
    }));
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
      // `from` and `target` join the set unconditionally: renaming a directory
      // that happens to be empty moves no file, and an empty dirty set is a
      // flush that never runs.
      dirty: new Set([...state.dirty, ...dirtyPaths, from, target]),
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
    // Saves are serialised. Two in flight at once could land out of order and
    // leave the older tree as the stored one, and the second would clear the
    // dirty set for work the first never wrote.
    //
    // `runSave` runs on both settle paths of the previous save: a save that
    // failed must not block the retry queued behind it.
    const run = saveChain.then(runSave, runSave);
    // The chain itself never rejects, so one failure cannot poison every
    // later flush. Callers still see the rejection through `run`.
    saveChain = run.catch(() => undefined);
    await run;
  },
}));

/** One save. Always called with the lock held by {@link FileState.flush}. */
async function runSave(): Promise<void> {
  const get = useFileStore.getState;
  const set = useFileStore.setState;
  const { projectId, files, dirs, dirty, meta } = get();
  if (!projectId || !dirty.size) return;
  if (!get().canWrite()) {
    set({ dirty: new Set() });
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  set({ saving: true, error: null });
  try {
    // The exact tree handed to the repository. Edits made while the write is in
    // flight are compared against it below rather than being marked clean —
    // clearing the whole set here silently dropped them.
    const written = files;
    const changed = new Set(dirty);
    await repository().saveFiles(projectId, written, dirs, changed);
    const language = detectProjectLanguage(Object.keys(written));
    if (meta && meta.language !== language) {
      await repository().updateProject(projectId, { language });
      set({ meta: { ...meta, language } });
    }
    const updatedAt = Date.now();
    set((state) => ({
      dirty: new Set([...state.dirty].filter((path) => state.files[path] !== written[path])),
      saving: false,
      lastSavedAt: updatedAt,
    }));
    const current = get().meta;
    if (current) useProjectStore.getState().upsertLocal({ ...current, updatedAt });
  } catch (error) {
    // Keep the dirty set so the next flush retries the same work.
    set({ saving: false, error: errorMessage(error) });
    throw error;
  }
}

/** Persist pending edits when the tab goes away. */
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void useFileStore.getState().flush().catch(() => undefined);
    }
  });
}
