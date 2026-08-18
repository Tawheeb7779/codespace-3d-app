import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TerminalLine } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

interface TerminalState {
  lines: TerminalLine[];
  addLine: (line: Omit<TerminalLine, 'id' | 'timestamp'>) => void;
  clear: () => void;
  executeCommand: (cmd: string) => void;
}

const genId = () => `term_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      lines: [
        {
          id: genId(),
          type: 'info' as const,
          content: 'CodeSpace 3D Terminal v1.0.0 — Type "help" for available commands.',
          timestamp: Date.now(),
        },
      ],

      addLine: (line) =>
        set((state) => ({
          lines: [...state.lines, { ...line, id: genId(), timestamp: Date.now() }],
        })),

      clear: () => set({ lines: [] }),

      executeCommand: (cmd) => {
        const trimmed = cmd.trim();
        if (!trimmed) return;

        const addLine = get().addLine;
        addLine({ type: 'input', content: trimmed });

        const parts = trimmed.split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
          case 'help':
            addLine({ type: 'output', content: 'Available commands:' });
            addLine({ type: 'output', content: '  help     — Show this help message' });
            addLine({ type: 'output', content: '  clear    — Clear the terminal' });
            addLine({ type: 'output', content: '  ls       — List project files' });
            addLine({ type: 'output', content: '  pwd      — Print working directory' });
            addLine({ type: 'output', content: '  echo     — Print text' });
            addLine({ type: 'output', content: '  project  — Show project info' });
            addLine({ type: 'output', content: '  date     — Show current date/time' });
            addLine({ type: 'output', content: '  whoami   — Show current user' });
            addLine({ type: 'output', content: '  version  — Show CodeSpace 3D version' });
            break;
          case 'clear':
            set({ lines: [] });
            break;
          case 'ls': {
            const project = useProjectStore.getState().getActiveProject();
            if (!project) {
              addLine({ type: 'error', content: 'No active project' });
              break;
            }
            const rootFiles = project.files.filter((f) => f.parentId === null);
            rootFiles.forEach((f) => {
              addLine({ type: 'output', content: `${f.type === 'folder' ? '📁' : '📄'} ${f.name}` });
            });
            break;
          }
          case 'pwd':
            addLine({ type: 'output', content: '/workspace/codespace-3d' });
            break;
          case 'echo':
            addLine({ type: 'output', content: args.join(' ') });
            break;
          case 'project': {
            const project = useProjectStore.getState().getActiveProject();
            if (!project) {
              addLine({ type: 'error', content: 'No active project' });
              break;
            }
            addLine({ type: 'output', content: `Name: ${project.name}` });
            addLine({ type: 'output', content: `Template: ${project.template}` });
            addLine({ type: 'output', content: `Files: ${project.files.length}` });
            addLine({ type: 'output', content: `Created: ${new Date(project.createdAt).toISOString()}` });
            break;
          }
          case 'date':
            addLine({ type: 'output', content: new Date().toString() });
            break;
          case 'whoami':
            addLine({ type: 'output', content: 'developer@codespace3d' });
            break;
          case 'version':
            addLine({ type: 'output', content: 'CodeSpace 3D v1.0.0 (browser-ide)' });
            break;
          default:
            addLine({ type: 'error', content: `Command not found: ${command}. Type "help" for available commands.` });
        }
      },
    }),
    { name: 'codespace-terminal' }
  )
);
