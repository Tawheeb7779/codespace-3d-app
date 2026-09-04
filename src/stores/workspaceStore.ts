import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Workspace } from '@/types';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { errorMessage, uid } from '@/lib/utils';

/**
 * Workspaces: one account's named groupings of projects.
 *
 * A workspace is a view, not a permission. Adding a project to one changes
 * nothing about who can read it — that stays with project membership — which
 * is why this store never consults roles and the database policy for the table
 * is simply "owner only". Getting this wrong would turn a convenience feature
 * into an access-control bypass.
 *
 * Only the active workspace id is persisted locally; the workspaces themselves
 * live in the project repository, so they survive the same way projects do.
 */

/** Workspaces shown in the recent list. */
export const MAX_RECENT_WORKSPACES = 8;

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (input: { name: string; description?: string; projectIds?: string[] }) => Promise<Workspace>;
  rename: (id: string, name: string) => Promise<void>;
  describe: (id: string, description: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  addProject: (id: string, projectId: string) => Promise<void>;
  removeProject: (id: string, projectId: string) => Promise<void>;
  /** Workspaces the owner touched most recently, pinned ones first. */
  recent: () => Workspace[];
  active: () => Workspace | null;
}

function repository() {
  return repositoryFor(useAuthStore.getState().user?.provider);
}

function currentUser() {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('You must be signed in to manage workspaces.');
  return user;
}

export function validateWorkspaceName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Workspace name cannot be empty.');
  if (clean.length > 60) throw new Error('Workspace name must be 60 characters or fewer.');
  return clean;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeId: null,
      loading: false,
      error: null,

      async load() {
        const user = useAuthStore.getState().user;
        if (!user) {
          set({ workspaces: [], loading: false });
          return;
        }
        set({ loading: true, error: null });
        try {
          const workspaces = await repository().listWorkspaces(user.id);
          // A remembered active workspace that has since been deleted must not
          // leave the UI pointing at nothing.
          const activeId = workspaces.some((w) => w.id === get().activeId) ? get().activeId : null;
          set({ workspaces, activeId, loading: false });
        } catch (error) {
          set({ error: errorMessage(error), loading: false });
        }
      },

      async create({ name, description = '', projectIds = [] }) {
        const user = currentUser();
        const now = Date.now();
        const workspace: Workspace = {
          id: uid('wsp'),
          name: validateWorkspaceName(name),
          description: description.trim().slice(0, 280),
          ownerId: user.id,
          projectIds: [...new Set(projectIds)],
          pinned: false,
          createdAt: now,
          updatedAt: now,
          openedAt: now,
        };
        await repository().saveWorkspace(workspace);
        set((state) => ({ workspaces: [workspace, ...state.workspaces], activeId: workspace.id }));
        return workspace;
      },

      async rename(id, name) {
        const clean = validateWorkspaceName(name);
        await patch(id, get, set, (workspace) => ({ ...workspace, name: clean }));
      },

      async describe(id, description) {
        const clean = description.trim().slice(0, 280);
        await patch(id, get, set, (workspace) => ({ ...workspace, description: clean }));
      },

      async togglePin(id) {
        await patch(id, get, set, (workspace) => ({ ...workspace, pinned: !workspace.pinned }));
      },

      async remove(id) {
        await repository().deleteWorkspace(id);
        set((state) => ({
          workspaces: state.workspaces.filter((workspace) => workspace.id !== id),
          activeId: state.activeId === id ? null : state.activeId,
        }));
      },

      async open(id) {
        set({ activeId: id });
        await patch(id, get, set, (workspace) => ({ ...workspace, openedAt: Date.now() }));
      },

      async addProject(id, projectId) {
        await patch(id, get, set, (workspace) =>
          workspace.projectIds.includes(projectId)
            ? workspace
            : { ...workspace, projectIds: [...workspace.projectIds, projectId] },
        );
      },

      async removeProject(id, projectId) {
        await patch(id, get, set, (workspace) => ({
          ...workspace,
          projectIds: workspace.projectIds.filter((entry) => entry !== projectId),
        }));
      },

      recent: () =>
        [...get().workspaces]
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return b.openedAt - a.openedAt;
          })
          .slice(0, MAX_RECENT_WORKSPACES),

      active: () => get().workspaces.find((workspace) => workspace.id === get().activeId) ?? null,
    }),
    {
      name: 'forge.workspace',
      // Only which workspace is open. The workspaces themselves are project
      // data and belong in the repository, where they are shared across
      // devices once a cloud backend is configured.
      partialize: (state) => ({ activeId: state.activeId }),
    },
  ),
);

/**
 * Apply a change locally and persist it, rolling back if the write fails.
 *
 * Every mutation here is small and reversible, so the optimistic update is
 * what makes the UI feel immediate; the rollback is what keeps it honest when
 * storage refuses.
 */
async function patch(
  id: string,
  get: () => WorkspaceState,
  set: (partial: Partial<WorkspaceState>) => void,
  change: (workspace: Workspace) => Workspace,
): Promise<void> {
  const before = get().workspaces;
  const target = before.find((workspace) => workspace.id === id);
  if (!target) throw new Error('That workspace no longer exists.');
  const updated = { ...change(target), updatedAt: Date.now() };
  set({ workspaces: before.map((workspace) => (workspace.id === id ? updated : workspace)) });
  try {
    await repository().saveWorkspace(updated);
  } catch (error) {
    set({ workspaces: before });
    throw error;
  }
}
