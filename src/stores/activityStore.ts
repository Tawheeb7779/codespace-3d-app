import { create } from 'zustand';
import type { ActivityAction, ActivityEvent } from '@/types';
import { activityEvent, mergeActivity } from '@/lib/activity';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { errorMessage, uid } from '@/lib/utils';

/**
 * The project activity timeline.
 *
 * Recording is deliberately best-effort and never blocks the action it
 * describes: a commit that succeeded must not be reported as failed because
 * writing its timeline row did not. Failures surface as a stored error rather
 * than a thrown one, and the event stays in the local list either way.
 */

/** Events kept in memory for the panel. */
export const MAX_ACTIVITY = 100;

interface ActivityState {
  projectId: string | null;
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  record: (action: ActivityAction, subject?: string) => Promise<void>;
  clearLocal: () => void;
}

function repository() {
  return repositoryFor(useAuthStore.getState().user?.provider);
}

export const useActivityStore = create<ActivityState>()((set, get) => ({
  projectId: null,
  events: [],
  loading: false,
  error: null,

  async load(projectId) {
    set({ projectId, loading: true, error: null });
    try {
      const events = await repository().listActivity(projectId, MAX_ACTIVITY);
      // Guard against a slow load landing after the user opened another
      // project: the answer would be for the wrong timeline.
      if (get().projectId !== projectId) return;
      set({ events, loading: false });
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  async record(action, subject) {
    const user = useAuthStore.getState().user;
    const projectId = get().projectId;
    if (!user || !projectId) return;

    const event = activityEvent(
      {
        projectId,
        actorId: user.id,
        actorName: user.displayName || user.email,
        action,
        subject,
      },
      uid('act'),
    );

    // Shown immediately; persistence is what may fail.
    set((state) => ({ events: mergeActivity(state.events, [event], MAX_ACTIVITY) }));
    try {
      await repository().recordActivity(event);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  clearLocal: () => set({ projectId: null, events: [], error: null }),
}));

/**
 * Record an event without needing the store in scope.
 *
 * Call sites are spread across git, preview and agent flows, and none of them
 * should have to care whether a timeline is loaded.
 */
export function recordActivity(action: ActivityAction, subject?: string): void {
  void useActivityStore.getState().record(action, subject);
}
