import { create } from 'zustand';
import { execute, type ShellLine, type ShellSession } from '@/lib/shell';
import { createShellHost } from '@/lib/shellHost';
import { uid } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Which environment a terminal session belongs to.
 *
 * This is a property of the **session**, not of the panel. That is the whole
 * distinction: a panel-level setting means choosing "Linux" takes the project
 * terminal off the screen, and the two environments are then two views of one
 * terminal rather than two terminals. They are not. A person needs `npm test`
 * running in the project *while* they work in a Linux shell, and each needs its
 * own process, working directory, history, scrollback and lifecycle.
 *
 * Three values, because there are genuinely three things:
 *
 * `project` is the in-browser shell over the project's virtual filesystem.
 * Instant, offline, limited to what a browser can do, and the one that always
 * exists — a deployment with no container gateway has this and nothing else.
 *
 * `project-container` is the same *project* in a real Linux container: the
 * project's files are synchronised into it, real git runs against them, and it
 * is authorised by project membership. Still project-scoped.
 *
 * `linux` is the Linux workspace, which is not a project at all. It belongs to
 * the person, mounts no project, starts empty, and is authorised by identity
 * alone. Files reach it only through an explicit transfer. Conflating it with
 * the two above is exactly the mistake the architecture exists to prevent.
 */
export type TerminalEnvironment = 'project' | 'project-container' | 'linux';

/** Every environment, in the order a person is offered them. */
export const TERMINAL_ENVIRONMENTS: readonly TerminalEnvironment[] = [
  'project',
  'project-container',
  'linux',
];

/** The name a person reads, and the name the agent must use. One list. */
export const ENVIRONMENT_LABEL: Record<TerminalEnvironment, string> = {
  project: 'Project Terminal',
  'project-container': 'Project Terminal (Linux)',
  linux: 'Linux Terminal',
};

/** The short form, for a tab badge where the full name will not fit. */
export const ENVIRONMENT_BADGE: Record<TerminalEnvironment, string> = {
  project: 'project',
  'project-container': 'project·linux',
  linux: 'linux',
};

export interface TerminalSession extends ShellSession {
  id: string;
  name: string;
  /**
   * Where this session's commands run. Fixed for the session's life: a
   * terminal that changed environment underneath a running process would be a
   * different machine with the same scrollback.
   */
  environment: TerminalEnvironment;
  lines: ShellLine[];
  busy: boolean;
  /** Incremented on every mutation so the xterm view can sync incrementally. */
  revision: number;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeId: string | null;
  createSession: (environment?: TerminalEnvironment) => string;
  /**
   * Return the active session in an environment, creating one if there is none.
   *
   * Environment-aware because the callers that matter are not the panel: the
   * agent's shell tool and the task runner both mean "the in-browser project
   * shell", and handing them whichever tab happened to be focused would write
   * their output into a container session that never renders it.
   */
  ensureSession: (environment?: TerminalEnvironment) => string;
  killSession: (id: string) => void;
  setActive: (id: string) => void;
  run: (id: string, command: string) => Promise<void>;
  append: (id: string, lines: ShellLine[]) => void;
  clear: (id: string) => void;
  /** Give a session a name of its own, so several are tellable apart. */
  renameSession: (id: string, name: string) => void;
  /** Everything one session has printed, as plain text for copying or saving. */
  transcript: (id: string) => string;
  /**
   * Recent output, optionally from one environment.
   *
   * The agent asks this to see what a command printed. Without the filter it
   * would read a Linux workspace's scrollback while reasoning about the
   * project, which is a different machine's output presented as the project's.
   */
  recentOutput: (limit?: number, environment?: TerminalEnvironment) => string;
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

/**
 * A default name that says which environment this is.
 *
 * "Terminal 1" and "Terminal 2" would leave the two environments tellable apart
 * only by remembering which tab was opened when — the confusion this whole
 * refactor exists to remove. The number is scoped to the environment, so the
 * second Linux terminal is "Linux 2" even when four project terminals are open.
 */
function defaultName(environment: TerminalEnvironment, existing: TerminalSession[]): string {
  const base = { project: 'project', 'project-container': 'project·linux', linux: 'linux' }[
    environment
  ];
  const count = existing.filter((session) => session.environment === environment).length;
  return count === 0 ? base : `${base} ${count + 1}`;
}

/**
 * The banner belongs to the in-browser shell alone.
 *
 * A container session's first bytes come from a real PTY, and writing this
 * above them would be the IDE putting words in a shell's mouth.
 */
function newSession(environment: TerminalEnvironment, existing: TerminalSession[]): TerminalSession {
  const banner = environment === 'project' && useSettingsStore.getState().terminal.showBanner;
  return {
    id: uid('term'),
    name: defaultName(environment, existing),
    environment,
    cwd: '',
    history: [],
    lines: banner ? [...BANNER] : [],
    busy: false,
    revision: 0,
  };
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  sessions: [],
  activeId: null,

  createSession(environment = 'project') {
    const session = newSession(environment, get().sessions);
    set((state) => ({ sessions: [...state.sessions, session], activeId: session.id }));
    return session.id;
  },

  ensureSession(environment = 'project') {
    const { sessions, activeId } = get();
    const active = sessions.find((session) => session.id === activeId);
    if (active?.environment === environment) return active.id;
    const existing = sessions.find((session) => session.environment === environment);
    if (existing) return existing.id;
    return get().createSession(environment);
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
    /*
     * Only the in-browser shell executes here.
     *
     * A container session's input goes to a PTY as bytes; running it through
     * the browser's interpreter instead would print a plausible answer that no
     * machine produced. Refusing is the honest behaviour, and the callers that
     * mean the in-browser shell ask `ensureSession('project')` for a session
     * that can.
     */
    if (session.environment !== 'project') return;
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

  recentOutput(limit = 120, environment) {
    const { sessions, activeId } = get();
    const pool = environment
      ? sessions.filter((session) => session.environment === environment)
      : sessions;
    const session = pool.find((s) => s.id === activeId) ?? pool[0];
    if (!session) return '';
    return session.lines
      .slice(-limit)
      .map((line) => line.text)
      .join('\n');
  },
}));
