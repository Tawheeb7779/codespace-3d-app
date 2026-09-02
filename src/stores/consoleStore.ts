import { create } from 'zustand';
import type { ConsoleEntry, ConsoleLevel } from '@/types';
import { uid } from '@/lib/utils';

const MAX_ENTRIES = 800;

interface ConsoleState {
  entries: ConsoleEntry[];
  filter: Set<ConsoleLevel>;
  query: string;
  append: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'>) => void;
  clear: () => void;
  toggleLevel: (level: ConsoleLevel) => void;
  setQuery: (query: string) => void;
}

export const ALL_LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

export const useConsoleStore = create<ConsoleState>()((set) => ({
  entries: [],
  filter: new Set(ALL_LEVELS),
  query: '',

  append: (entry) =>
    set((state) => {
      const next = [...state.entries, { ...entry, id: uid('log'), timestamp: Date.now() }];
      // Bound the buffer so a runaway log loop cannot exhaust memory.
      return { entries: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next };
    }),

  clear: () => set({ entries: [] }),

  toggleLevel: (level) =>
    set((state) => {
      const filter = new Set(state.filter);
      if (filter.has(level)) filter.delete(level);
      else filter.add(level);
      return { filter };
    }),

  setQuery: (query) => set({ query }),
}));

export const consoleLog = {
  build: (message: string, level: ConsoleLevel = 'info') =>
    useConsoleStore.getState().append({ channel: 'build', level, message }),
  ide: (message: string, level: ConsoleLevel = 'info') =>
    useConsoleStore.getState().append({ channel: 'ide', level, message }),
  preview: (message: string, level: ConsoleLevel) =>
    useConsoleStore.getState().append({ channel: 'preview', level, message }),
};
