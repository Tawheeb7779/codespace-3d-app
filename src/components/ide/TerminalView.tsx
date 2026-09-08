import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMonacoTheme } from '@/hooks/useTheme';
import type { ShellLine } from '@/lib/shell';
import { commandNames } from '@/lib/shell';

/**
 * xterm.js bound to the Forge Shell.
 *
 * The terminal owns line editing (echo, backspace, history, tab completion) and
 * hands complete command lines to the store, which runs them against the
 * project's file system and appends the real output.
 *
 * Instances live in a module-level registry keyed by session id, not in React
 * state. Switching panels or tabs then reattaches the same live terminal —
 * scrollback and cursor position intact — and avoids the create/dispose race
 * that xterm's asynchronous renderer setup is prone to.
 */

/*
 * The terminal's sixteen colours, drawn from the same palette as the rest.
 *
 * A shell that ships its own defaults is the fastest way to make an interface
 * look assembled from parts: the greens and reds arrive from a different
 * decade than everything around them. These are the interface's own semantic
 * colours, with the remaining hues chosen to sit at the same saturation.
 */
const COLORS = {
  dark: {
    // Exactly --c-surface-sunken (7 9 11). It had drifted to #070909, which is
    // invisible but is the drift this whole block is exposed to: xterm needs
    // literals, so nothing checks these against the tokens they stand for.
    background: '#07090b',
    foreground: '#e3e7ed',
    cursor: '#38b0d6',
    selectionBackground: '#12384a',
    black: '#0b0d10',
    red: '#f07171',
    green: '#3dc782',
    yellow: '#e6b04a',
    blue: '#7fb2e8',
    magenta: '#c39ae0',
    cyan: '#38b0d6',
    white: '#e3e7ed',
    brightBlack: '#6d7581',
    brightRed: '#f79191',
    brightGreen: '#63d69b',
    brightYellow: '#f0c473',
    brightBlue: '#9ac6f0',
    brightMagenta: '#d4b4ea',
    brightCyan: '#68c8e6',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff',
    foreground: '#15191f',
    cursor: '#0d749c',
    selectionBackground: '#dbf0f8',
    black: '#15191f',
    red: '#ba2828',
    green: '#0d7742',
    yellow: '#8d5c06',
    blue: '#1d5fb8',
    magenta: '#7c2d9e',
    cyan: '#0d749c',
    white: '#f6f7f9',
    brightBlack: '#555c67',
    brightRed: '#d63b3b',
    brightGreen: '#158f52',
    brightYellow: '#a56f0b',
    brightBlue: '#2a72d0',
    brightMagenta: '#9139b5',
    brightCyan: '#1189b5',
    brightWhite: '#ffffff',
  },
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2;37m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  accent: '\x1b[38;5;69m',
};

function render(line: ShellLine): string {
  switch (line.kind) {
    case 'command':
      return `${ANSI.accent}${line.text}${ANSI.reset}`;
    case 'stderr':
      return `${ANSI.red}${line.text}${ANSI.reset}`;
    case 'info':
      return `${ANSI.cyan}${line.text}${ANSI.reset}`;
    default:
      return line.text;
  }
}

interface Instance {
  term: Terminal;
  fit: FitAddon;
  /** The terminal's own host element, moved between mount points. */
  host: HTMLDivElement;
  written: number;
  input: string;
  historyIndex: number | null;
}

const instances = new Map<string, Instance>();

function safeFit(instance: Instance) {
  const { host, fit } = instance;
  // Fitting a detached or zero-sized terminal reaches into xterm's renderer
  // before it exists; measure first.
  if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
  try {
    fit.fit();
  } catch {
    /* the panel may be mid-layout or collapsed */
  }
}

function createInstance(sessionId: string, options: { fontSize: number; fontFamily: string; light: boolean }): Instance {
  const host = document.createElement('div');
  host.style.height = '100%';
  host.style.width = '100%';

  const term = new Terminal({
    fontSize: Math.max(9, options.fontSize),
    fontFamily: options.fontFamily,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    theme: options.light ? COLORS.light : COLORS.dark,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const instance: Instance = { term, fit, host, written: 0, input: '', historyIndex: null };

  const cwd = () => useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.cwd ?? '';
  const prompt = () => term.write(`\r\n${ANSI.dim}${cwd()}${ANSI.reset}$ `);

  const submit = async () => {
    const command = instance.input;
    instance.input = '';
    instance.historyIndex = null;
    // Erase the echoed input line: the store appends the canonical
    // `cwd$ command` line, and writing both would double it.
    term.write('\r\x1b[K');
    await useTerminalStore.getState().run(sessionId, command);
    prompt();
  };

  term.onData((data) => {
    const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session || session.busy) return;

    if (data === '\r') {
      void submit();
      return;
    }
    if (data === '\x7f') {
      if (instance.input.length) {
        instance.input = instance.input.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }
    if (data === '\x03') {
      term.write('^C');
      instance.input = '';
      prompt();
      return;
    }
    if (data === '\x0c') {
      useTerminalStore.getState().clear(sessionId);
      return;
    }
    if (data === '\x1b[A' || data === '\x1b[B') {
      const history = session.history;
      if (!history.length) return;
      const next =
        data === '\x1b[A'
          ? instance.historyIndex === null
            ? history.length - 1
            : Math.max(0, instance.historyIndex - 1)
          : instance.historyIndex === null
            ? null
            : Math.min(history.length - 1, instance.historyIndex + 1);
      instance.historyIndex = next;
      const value = next === null ? '' : history[next];
      term.write(`\r\x1b[K${ANSI.dim}${cwd()}${ANSI.reset}$ ${value}`);
      instance.input = value;
      return;
    }
    if (data === '\t') {
      const partial = instance.input.trim();
      if (partial.includes(' ')) return;
      const matches = commandNames().filter((name) => name.startsWith(partial));
      if (matches.length === 1) {
        const completion = matches[0].slice(partial.length);
        instance.input += completion;
        term.write(completion);
      } else if (matches.length > 1) {
        term.write(`\r\n${matches.join('  ')}`);
        term.write(`\r\n${ANSI.dim}${cwd()}${ANSI.reset}$ ${instance.input}`);
      }
      return;
    }
    // Ignore other control sequences rather than echoing garbage.
    if (data < ' ') return;
    instance.input += data;
    term.write(data);
  });

  const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
  session?.lines.forEach((line) => term.writeln(render(line)));
  instance.written = session?.lines.length ?? 0;
  prompt();

  instances.set(sessionId, instance);
  return instance;
}

/** Dispose terminals whose session has been killed. */
useTerminalStore.subscribe((state) => {
  const live = new Set(state.sessions.map((s) => s.id));
  for (const [id, instance] of instances) {
    if (live.has(id)) continue;
    instances.delete(id);
    instance.host.remove();
    instance.term.dispose();
  }
});

export function TerminalView({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fontSize = useSettingsStore((s) => s.terminal.fontSize);
  const fontFamily = useSettingsStore((s) => s.editor.fontFamily);
  const theme = useMonacoTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const instance =
      instances.get(sessionId) ??
      createInstance(sessionId, { fontSize, fontFamily, light: theme === 'forge-light' });

    container.appendChild(instance.host);
    requestAnimationFrame(() => safeFit(instance));
    instance.term.focus();

    const onResize = () => safeFit(instance);
    window.addEventListener('resize', onResize);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    observer?.observe(container);

    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      // Detach without disposing: the instance outlives this mount.
      instance.host.remove();
    };
    // Only the session identity should re-attach; option changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Stream lines produced outside the terminal (agent, panels, clear).
  useEffect(
    () =>
      useTerminalStore.subscribe((state) => {
        const instance = instances.get(sessionId);
        if (!instance) return;
        const session = state.sessions.find((s) => s.id === sessionId);
        if (!session) return;
        if (session.lines.length < instance.written) {
          instance.term.clear();
          instance.written = 0;
        }
        for (let i = instance.written; i < session.lines.length; i++) {
          instance.term.writeln(render(session.lines[i]));
        }
        instance.written = session.lines.length;
      }),
    [sessionId],
  );

  useEffect(() => {
    const instance = instances.get(sessionId);
    if (!instance) return;
    instance.term.options.theme = theme === 'forge-light' ? COLORS.light : COLORS.dark;
    instance.term.options.fontSize = Math.max(9, fontSize);
    instance.term.options.fontFamily = fontFamily;
    safeFit(instance);
  }, [sessionId, theme, fontSize, fontFamily]);

  return (
    <div
      ref={containerRef}
      // Clicking anywhere in the panel — including the padding around the
      // screen — should put the caret in the terminal, as a real one does.
      onMouseUp={() => {
        const instance = instances.get(sessionId);
        if (instance && !window.getSelection()?.toString()) instance.term.focus();
      }}
      className="h-full w-full px-2"
    />
  );
}
