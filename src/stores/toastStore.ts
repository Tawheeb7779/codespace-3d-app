import { create } from 'zustand';
import type { ToastMessage } from '@/types';
import { uid } from '@/lib/utils';

/** A notification that has been shown, kept after its toast has gone. */
export interface NotificationRecord extends ToastMessage {
  at: number;
}

/** How much history to keep. Enough to scroll back through a session. */
const MAX_HISTORY = 100;

interface ToastState {
  toasts: ToastMessage[];
  /**
   * Everything that was announced, newest first.
   *
   * A toast is gone in four seconds, which is right for the moment and wrong
   * afterwards: a push that failed while the user was reading code, or a
   * commit that landed during a build, is exactly the thing they want to find
   * again. The toast is the interruption; this is the record.
   */
  history: NotificationRecord[];
  /** Notifications recorded since the centre was last opened. */
  unread: number;
  push: (toast: Omit<ToastMessage, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  markRead: () => void;
  clearHistory: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  history: [],
  unread: 0,
  push: (toast) => {
    const id = uid('toast');
    // Errors stay until dismissed; everything else auto-expires.
    const duration = toast.duration ?? (toast.variant === 'error' ? 0 : 4000);
    const message = { ...toast, id, duration };
    set((state) => ({
      toasts: [...state.toasts.slice(-4), message],
      history: [{ ...message, at: Date.now() }, ...state.history].slice(0, MAX_HISTORY),
      unread: state.unread + 1,
    }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  // Dismissing every toast on screen does not erase what happened.
  clear: () => set({ toasts: [] }),
  markRead: () => set({ unread: 0 }),
  clearHistory: () => set({ history: [], unread: 0 }),
}));

export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'info' }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'success' }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: 'warning' }),
  error: (title: string, description?: string, action?: ToastMessage['action']) =>
    useToastStore.getState().push({ title, description, variant: 'error', action }),
};
