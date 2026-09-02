import { create } from 'zustand';
import type { ToastMessage } from '@/types';
import { uid } from '@/lib/utils';

interface ToastState {
  toasts: ToastMessage[];
  push: (toast: Omit<ToastMessage, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) => {
    const id = uid('toast');
    // Errors stay until dismissed; everything else auto-expires.
    const duration = toast.duration ?? (toast.variant === 'error' ? 0 : 4000);
    set((state) => ({ toasts: [...state.toasts.slice(-4), { ...toast, id, duration }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
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
