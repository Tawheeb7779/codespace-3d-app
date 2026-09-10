import { create } from 'zustand';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  addComment,
  deleteComment,
  editComment,
  listComments,
  setResolved,
  toThreads,
  type Comment,
  type CommentThread,
} from '@/lib/collab/comments';
import { errorMessage } from '@/lib/utils';

/**
 * A project's conversation, kept current by the database rather than by a timer.
 *
 * The list is read once when a project opens and then maintained from Postgres
 * change events. There is no interval: polling a comments table every few
 * seconds is a query per tab per tick forever, and it is still slower than a
 * push. RLS applies to the stream exactly as it applies to the read, so a
 * subscriber is only sent rows they could have selected.
 *
 * **A dropped subscription is reported, not hidden.** If the channel fails, the
 * list on screen is a snapshot with no way to know what it is missing, and
 * `live` says so — a stale thread that looks current is how somebody replies to
 * a question that was answered ten minutes ago.
 */

interface CommentState {
  projectId: string | null;
  comments: Comment[];
  loading: boolean;
  error: string | null;
  /** True only while change events are actually arriving. */
  live: boolean;

  load: (projectId: string) => Promise<void>;
  leave: () => void;
  post: (input: {
    authorId: string;
    body: string;
    path?: string;
    line?: number | null;
    parentId?: string | null;
    mentions?: string[];
  }) => Promise<void>;
  edit: (id: string, body: string) => Promise<void>;
  resolve: (id: string, resolverId: string, resolved: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  threads: () => CommentThread[];
  /** Threads anchored to one file. */
  threadsFor: (path: string) => CommentThread[];
  /** Threads where this person was named. */
  mentioning: (userId: string) => CommentThread[];
}

let channel: RealtimeChannel | null = null;

function stopChannel() {
  if (!channel) return;
  void channel.unsubscribe();
  channel = null;
}

export const useCommentStore = create<CommentState>()((set, get) => ({
  projectId: null,
  comments: [],
  loading: false,
  error: null,
  live: false,

  async load(projectId) {
    stopChannel();
    set({ projectId, loading: true, error: null, comments: [], live: false });

    if (!supabase) {
      set({
        loading: false,
        error: 'Comments need a Supabase project. In local development mode this workspace is yours alone.',
      });
      return;
    }

    try {
      const comments = await listComments(projectId);
      // A second project may have been opened while this read was in flight.
      if (get().projectId !== projectId) return;
      set({ comments, loading: false });
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ loading: false, error: errorMessage(error) });
      return;
    }

    /*
     * Maintained by change events from here on.
     *
     * An insert or update arrives without the profile join, so the author's
     * name is not in it — the row is merged over what is already known, and a
     * name that was never known shows as "Someone" rather than as a guess.
     */
    channel = supabase
      .channel(`comments:${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_comments', filter: `project_id=eq.${projectId}` },
        (payload) => {
          if (get().projectId !== projectId) return;
          const row = (payload.new ?? payload.old) as { id?: string } | null;
          if (!row?.id) return;

          if (payload.eventType === 'DELETE') {
            set((state) => ({
              comments: state.comments.filter(
                (comment) => comment.id !== row.id && comment.parentId !== row.id,
              ),
            }));
            return;
          }

          // Re-read rather than reconstruct: the event carries raw columns and
          // no author name, and inventing one is exactly what this must not do.
          void listComments(projectId)
            .then((comments) => {
              if (get().projectId === projectId) set({ comments });
            })
            .catch(() => undefined);
        },
      )
      .subscribe((status) => {
        if (get().projectId !== projectId) return;
        if (status === 'SUBSCRIBED') set({ live: true });
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          set({ live: false });
        }
      });
  },

  leave() {
    stopChannel();
    set({ projectId: null, comments: [], loading: false, error: null, live: false });
  },

  async post(input) {
    const projectId = get().projectId;
    if (!projectId) throw new Error('No project is open.');
    const comment = await addComment({ ...input, projectId });
    // Shown at once rather than waiting for the round trip: the change event
    // will arrive and replace it with the same row.
    set((state) =>
      state.comments.some((existing) => existing.id === comment.id)
        ? state
        : { comments: [...state.comments, comment] },
    );
  },

  async edit(id, body) {
    await editComment(id, body);
    set((state) => ({
      comments: state.comments.map((comment) =>
        comment.id === id ? { ...comment, body: body.trim() } : comment,
      ),
    }));
  },

  async resolve(id, resolverId, resolved) {
    await setResolved(id, resolverId, resolved);
    set((state) => ({
      comments: state.comments.map((comment) =>
        comment.id === id ? { ...comment, resolvedAt: resolved ? Date.now() : null } : comment,
      ),
    }));
  },

  async remove(id) {
    await deleteComment(id);
    set((state) => ({
      // A thread's replies go with it, as the foreign key does in the database.
      comments: state.comments.filter(
        (comment) => comment.id !== id && comment.parentId !== id,
      ),
    }));
  },

  threads: () => toThreads(get().comments),

  threadsFor: (path) => toThreads(get().comments).filter((thread) => thread.root.path === path),

  mentioning: (userId) =>
    toThreads(get().comments).filter(
      (thread) =>
        thread.root.mentions.includes(userId) ||
        thread.replies.some((reply) => reply.mentions.includes(userId)),
    ),
}));
