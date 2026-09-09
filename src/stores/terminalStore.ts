import { create } from 'zustand';
import { execute, type ShellLine, type ShellSession } from '@/lib/shell';
import { createShellHost } from '@/lib/shellHost';
import { uid } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';

export interface TerminalSession extends ShellSession {
  id: string;
  name: string;
  lines: ShellLine[];
  busy: boolean;
  /** Incremented on every mutation so the xterm view can sync incrementally. */
  revision: number;
}

/**
 * Where a terminal's commands actually run.
 *
 * `virtual` is the in-browser shell that has always been here: instant, offline,
 * and limited to what a browser can do. `container` is a real Linux shell in an
 * isolated workspace, which can install packages and run servers but needs
 * infrastructure to exist.
 *
 * Deliberately one setting for the panel rather than per session: a user thinks
 * "am I in the browser or on a machine", and two tabs in different worlds
 * sharing one prompt style is a trap.
 */
export type TerminalMode = 'virtual' | 'container';

interface TerminalState {
  sessions: TerminalSession[];
  activeId: string | null;
  mode: TerminalMode;
  setMode: (mode: TerminalMode) => void;
  createSession: () => string;
  /** Create the first session only if none exists. Safe to call repeatedly. */
  ensureSession: () => string;
  killSession: (id: string) => void;
  setActive: (id: string) => void;
  run: (id: string, command: string) => Promise<void>;
  append: (id: string, lines: ShellLine[]) => void;
  clear: (id: string) => void;
  /** Give a session a name of its own, so several are tellable apart. */
  renameSession: (id: string, name: string) => void;
  /** Everything one session has printed, as plain text for copying or saving. */
  transcript: (id: string) => string;
  recentOutput: (limit?: number) => string;
}

const BANNER: ShellLine[] = [
  { kind: 'info', text: 'TA CODE shell — commands operate on this project\'s virtual file system.' },
  { kind: 'info', text: 'Type "help" for the full list. Unlisted commands are not simulated.' },
];

/** Hard ceiling, whatever the setting says: scrollback lives in memory. */
const MAX_LINES_CEILING = 20_000;

/** How much scrollback to keep, from settings, clamped to something sane. */
function scrollbackLimit(): number {
  const configured = useSettingsStore.getState().terminal.scrollback;
  return Math.min(MAX_LINES_CEILING, Math.max(200, configured));
}

function trim(lines: ShellLine[]): ShellLine[] {
  const limit = scrollbackLimit();
  return lines.length > limit ? lines.slice(-limit) : lines;
}

function newSession(index: number): TerminalSession {
  return {
    id: uid('term'),
    name: index === 0 ? 'shell' : `shell ${index + 1}`,
    cwd: '',
    history: [],
    lines: useSettingsStore.getState().terminal.showBanner ? [...BANNER] : [],
    busy: false,
    revision: 0,
  };
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  sessions: [],
  activeId: null,
  // Virtual until something proves a container is available, so a deployment
  // with no gateway simply never leaves the mode that always works.
  mode: 'virtual',
  setMode: (mode) => set({ mode }),

  createSession() {
    const session = newSession(get().sessions.length);
    set((state) => ({ sessions: [...state.sessions, session], activeId: session.id }));
    return session.id;
  },

  ensureSession() {
    const { sessions, activeId } = get();
    if (sessions.length) return activeId ?? sessions[0].id;
    return get().createSession();
  },

  killSession(id) {
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeId =
        state.activeId === id ? (sessions[sessions.length - 1]?.id ?? null) : state.activeId;
      return { sessions, activeId };
    });
  },

  setActive: (id) => set({ activeId: id }),

  renameSession: (id, name) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        // An empty name would leave a tab with nothing to click, so a blank
        // rename is a no-op rather than an unlabelled session.
        session.id === id ? { ...session, name: name.trim() || session.name } : session,
      ),
    })),

  transcript: (id) => {
    const session = get().sessions.find((entry) => entry.id === id);
    if (!session) return '';
    return session.lines.map((line) => line.text).join('\n');
  },

  append(id, lines) {
    if (!lines.length) return;
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== id) return session;
        const next = [...session.lines, ...lines];
        return {
          ...session,
          lines: trim(next),
          revision: session.revision + 1,
        };
      }),
    }));
  },

  clear(id) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, lines: [], revision: session.revision + 1 } : session,
      ),
    }));
  },

  async run(id, command) {
    const session = get().sessions.find((s) => s.id === id);
    if (!session || session.busy) return;
    const trimmed = command.trim();

    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              busy: true,
              history: trimmed && s.history[s.history.length - 1] !== trimmed
                ? [...s.history, trimmed].slice(-200)
                : s.history,
              lines: [...s.lines, { kind: 'command' as const, text: `${s.cwd}$ ${command}` }],
              revision: s.revision + 1,
            }
          : s,
      ),
    }));

    if (!trimmed) {
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, busy: false } : s)),
      }));
      return;
    }

    // The shell mutates `cwd` on the session object it is handed.
    const working: ShellSession = { cwd: session.cwd, history: [...session.history, trimmed] };
    const result = await execute(trimmed, working, createShellHost());

    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== id) return s;
        const lines = result.control === 'clear' ? [] : [...s.lines, ...result.lines];
        return {
          ...s,
          cwd: working.cwd,
          busy: false,
          lines: trim(lines),
          revision: s.revision + 1,
        };
      }),
    }));
  },

  recentOutput(limit = 120) {
    const { sessions, activeId } = get();
    const session = sessions.find((s) => s.id === activeId) ?? sessions[0];
    if (!session) return '';
    return session.lines
      .slice(-limit)
      .map((line) => line.text)
      .join('\n');
  },
}));
