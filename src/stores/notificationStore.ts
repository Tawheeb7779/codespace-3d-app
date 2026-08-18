import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppNotification } from '@/types';

interface NotificationState {
  notifications: AppNotification[];
  addNotification: (n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
  clearRead: () => void;
  unreadCount: () => number;
}

const genId = () => `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const defaultNotifications: AppNotification[] = [
  { id: 'n1', type: 'project', title: 'Build Complete', message: 'Project Alpha compiled successfully in 2.4s.', read: false, timestamp: Date.now() - 300000 },
  { id: 'n2', type: 'team', title: 'New Member', message: 'Lena Park joined the project-alpha channel.', read: false, timestamp: Date.now() - 600000 },
  { id: 'n3', type: 'system', title: 'Storage Warning', message: 'Local storage usage at 65%. Consider archiving old assets.', read: false, timestamp: Date.now() - 900000 },
  { id: 'n4', type: 'project', title: 'File Synced', message: 'main.ts synced to cloud.', read: true, timestamp: Date.now() - 3600000 },
];

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      notifications: defaultNotifications,

      addNotification: (n) =>
        set((state) => ({
          notifications: [
            { ...n, id: genId(), timestamp: Date.now(), read: false },
            ...state.notifications,
          ],
        })),

      markAsRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        })),

      markAllAsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        })),

      clearAll: () => set({ notifications: [] }),

      clearRead: () =>
        set((state) => ({
          notifications: state.notifications.filter((n) => !n.read),
        })),

      unreadCount: () => get().notifications.filter((n) => !n.read).length,
    }),
    { name: 'codespace-notifications' }
  )
);
