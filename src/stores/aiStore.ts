import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PROVIDER,
  readApiKey,
  writeApiKey,
  type ChatMessage,
  type ProviderConfig,
} from '@/lib/ai/provider';
import { runAgent, type AgentActivity } from '@/lib/ai/agent';
import type { ToolContext } from '@/lib/ai/tools';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { execute, type ShellSession } from '@/lib/shell';
import { createShellHost } from '@/lib/shellHost';
import { errorMessage, uid } from '@/lib/utils';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  activities: AgentActivity[];
  timestamp: number;
}

interface AiState {
  provider: ProviderConfig;
  apiKeyPresent: boolean;
  /**
   * Session-scoped approval for irreversible tool calls: deleting a file, or
   * running a destructive shell command. Deliberately not persisted, so it
   * resets to off every time the app loads.
   */
  allowDestructive: boolean;
  messages: AssistantMessage[];
  transcript: ChatMessage[];
  running: boolean;
  error: string | null;

  setProvider: (patch: Partial<ProviderConfig>) => void;
  setApiKey: (key: string) => void;
  setAllowDestructive: (allowed: boolean) => void;
  send: (prompt: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

let controller: AbortController | null = null;

/** Build the tool context bound to the currently open project. */
function toolContext(): ToolContext {
  const fileStore = useFileStore.getState();
  return {
    files: fileStore.files,
    dirs: fileStore.dirs,
    canWrite: fileStore.canWrite(),
    allowDestructive: useAiStore.getState().allowDestructive,
    writeFile(path, content) {
      const store = useFileStore.getState();
      if (path in store.files) store.writeFile(path, content);
      else store.createFile(path, content);
      useEditorStore.getState().openTab(path);
    },
    deletePath(path) {
      useFileStore.getState().remove(path);
      useEditorStore.getState().removePath(path);
    },
    async runShell(command) {
      const terminal = useTerminalStore.getState();
      const id = terminal.activeId ?? terminal.createSession();
      const session: ShellSession = { cwd: '', history: [] };
      terminal.append(id, [{ kind: 'command', text: `agent$ ${command}` }]);
      const result = await execute(command, session, createShellHost());
      terminal.append(id, result.lines);
      return result.lines.map((line) => line.text).join('\n') || '(no output)';
    },
    terminalOutput: () => useTerminalStore.getState().recentOutput(),
  };
}

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
      provider: DEFAULT_PROVIDER,
      apiKeyPresent: typeof window !== 'undefined' && Boolean(readApiKey()),
      allowDestructive: false,
      messages: [],
      transcript: [],
      running: false,
      error: null,

      setProvider: (patch) => set((state) => ({ provider: { ...state.provider, ...patch } })),

      setApiKey: (key) => {
        writeApiKey(key.trim());
        set({ apiKeyPresent: Boolean(key.trim()) });
      },

      setAllowDestructive: (allowed) => set({ allowDestructive: allowed }),

      async send(prompt) {
        const text = prompt.trim();
        if (!text || get().running) return;

        const userMessage: AssistantMessage = {
          id: uid('msg'),
          role: 'user',
          text,
          activities: [],
          timestamp: Date.now(),
        };
        const assistantId = uid('msg');
        set((state) => ({
          messages: [
            ...state.messages,
            userMessage,
            {
              id: assistantId,
              role: 'assistant',
              text: '',
              activities: [],
              timestamp: Date.now(),
            },
          ],
          running: true,
          error: null,
        }));

        const patch = (updater: (message: AssistantMessage) => AssistantMessage) =>
          set((state) => ({
            messages: state.messages.map((m) => (m.id === assistantId ? updater(m) : m)),
          }));

        controller = new AbortController();
        const transcript: ChatMessage[] = [...get().transcript, { role: 'user', content: text }];

        try {
          const result = await runAgent(
            get().provider,
            readApiKey(),
            transcript,
            toolContext(),
            {
              onActivity: (activity) =>
                patch((message) => {
                  const activities = message.activities.some((a) => a.id === activity.id)
                    ? message.activities.map((a) => (a.id === activity.id ? activity : a))
                    : [...message.activities, activity];
                  return { ...message, activities };
                }),
              onText: (chunk) => patch((message) => ({ ...message, text: chunk })),
            },
            controller.signal,
          );
          set({ transcript: result.transcript, running: false });
          void useFileStore.getState().flush();
        } catch (error) {
          const message =
            error instanceof DOMException && error.name === 'AbortError'
              ? 'Cancelled.'
              : errorMessage(error);
          patch((existing) => ({
            ...existing,
            role: existing.text ? existing.role : 'error',
            text: existing.text || message,
          }));
          set({ running: false, error: message });
        } finally {
          controller = null;
        }
      },

      cancel() {
        controller?.abort();
        set({ running: false });
      },

      reset: () => set({ messages: [], transcript: [], error: null }),
    }),
    {
      name: 'forge.ai',
      // The API key is deliberately excluded: it lives in sessionStorage only.
      partialize: (state) => ({ provider: state.provider }),
    },
  ),
);
