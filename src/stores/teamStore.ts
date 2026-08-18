import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TeamMember, ChatChannel, ChatMessage } from '@/types';

interface TeamState {
  members: TeamMember[];
  channels: ChatChannel[];
  messages: ChatMessage[];
  selectedChannelId: string | null;
  addMember: (member: Omit<TeamMember, 'id'>) => void;
  removeMember: (id: string) => void;
  updateMember: (id: string, updates: Partial<TeamMember>) => void;
  addChannel: (channel: Omit<ChatChannel, 'id'>) => void;
  selectChannel: (id: string) => void;
  sendMessage: (channelId: string, authorId: string, authorName: string, content: string) => void;
  markChannelRead: (channelId: string) => void;
}

const genId = () => `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const defaultMembers: TeamMember[] = [
  { id: 'm1', name: 'Alex Chen', email: 'alex@codespace3d.dev', role: 'Owner', online: true, avatar: 'AC' },
  { id: 'm2', name: 'Sarah Kim', email: 'sarah@codespace3d.dev', role: 'Admin', online: true, avatar: 'SK' },
  { id: 'm3', name: 'Marcus Webb', email: 'marcus@codespace3d.dev', role: 'Developer', online: false, avatar: 'MW', lastSeen: Date.now() - 3600000 },
  { id: 'm4', name: 'Lena Park', email: 'lena@codespace3d.dev', role: 'Developer', online: true, avatar: 'LP' },
  { id: 'm5', name: 'David Wu', email: 'david@codespace3d.dev', role: 'Viewer', online: false, avatar: 'DW', lastSeen: Date.now() - 86400000 },
];

const defaultChannels: ChatChannel[] = [
  { id: 'c1', name: 'general', type: 'team', unread: 0, members: ['m1', 'm2', 'm3', 'm4', 'm5'] },
  { id: 'c2', name: 'project-alpha', type: 'project', unread: 2, members: ['m1', 'm2', 'm3'] },
  { id: 'c3', name: 'rendering-engine', type: 'project', unread: 0, members: ['m1', 'm3', 'm4'] },
  { id: 'c4', name: 'design-review', type: 'team', unread: 1, members: ['m1', 'm2', 'm4', 'm5'] },
];

const defaultMessages: ChatMessage[] = [
  { id: 'msg1', channelId: 'c1', authorId: 'm2', authorName: 'Sarah Kim', content: 'Morning everyone! Pushed the latest scene graph optimizations to the main branch.', timestamp: Date.now() - 7200000 },
  { id: 'msg2', channelId: 'c1', authorId: 'm4', authorName: 'Lena Park', content: 'Nice! I will review the transform updates this afternoon.', timestamp: Date.now() - 3600000 },
  { id: 'msg3', channelId: 'c1', authorId: 'm1', authorName: 'Alex Chen', content: 'Reminder: design sync at 3pm. We need to finalize the shader panel layout.', timestamp: Date.now() - 1800000 },
  { id: 'msg4', channelId: 'c2', authorId: 'm3', authorName: 'Marcus Webb', content: 'The WebGL context is losing state on resize. Investigating now.', timestamp: Date.now() - 900000 },
  { id: 'msg5', channelId: 'c2', authorId: 'm1', authorName: 'Alex Chen', content: 'Let me know if you need help with the context loss handler.', timestamp: Date.now() - 600000 },
];

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      members: defaultMembers,
      channels: defaultChannels,
      messages: defaultMessages,
      selectedChannelId: 'c1',

      addMember: (member) =>
        set((state) => ({ members: [...state.members, { ...member, id: genId() }] })),

      removeMember: (id) =>
        set((state) => ({ members: state.members.filter((m) => m.id !== id) })),

      updateMember: (id, updates) =>
        set((state) => ({
          members: state.members.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        })),

      addChannel: (channel) =>
        set((state) => ({ channels: [...state.channels, { ...channel, id: genId() }] })),

      selectChannel: (id) => set({ selectedChannelId: id }),

      sendMessage: (channelId, authorId, authorName, content) =>
        set((state) => ({
          messages: [
            ...state.messages,
            { id: genId(), channelId, authorId, authorName, content, timestamp: Date.now() },
          ],
        })),

      markChannelRead: (channelId) =>
        set((state) => ({
          channels: state.channels.map((c) =>
            c.id === channelId ? { ...c, unread: 0 } : c
          ),
        })),
    }),
    { name: 'codespace-team' }
  )
);
