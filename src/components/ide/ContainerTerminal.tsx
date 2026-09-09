import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFileStore } from '@/stores/fileStore';
import { useMonacoTheme } from '@/hooks/useTheme';
import { supabase } from '@/lib/supabase';
import {
  ContainerTerminal as ContainerTerminalClient,
  gatewayUrl,
  type ConnectionState,
} from '@/lib/terminal/containerClient';
import { attachWorkspaceSync, detachWorkspaceSync } from '@/lib/terminal/fileStoreSync';
import { TERMINAL_COLORS } from '@/components/ide/terminalColors';
import { cx } from '@/lib/utils';

/**
 * A real Linux shell, rendered by the same xterm the virtual terminal uses.
 *
 * The panel, the tabs and the styling are shared; what differs is the data
 * path, and it differs completely. The virtual terminal is line-based — xterm
 * collects a line, the store executes it, the result is written back — because
 * the in-browser shell has no concept of a running process to type into. This
 * one is a byte stream in both directions: every keystroke goes to a PTY as it
 * is typed, and everything the PTY emits is written straight to the screen.
 * That is what makes `vim`, a password prompt, `Ctrl+C` and a progress bar work
 * rather than approximately work.
 *
 * The xterm instance is kept alive across mounts, like the virtual terminal's,
 * so collapsing the panel does not clear the screen. The *connection* is
 * separate again: closing the panel detaches without killing, so a development
 * server keeps running and is still there when the panel reopens.
 */

interface Live {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  client: ContainerTerminalClient;
}

const live = new Map<string, Live>();

function safeFit(entry: Live) {
  if (!entry.host.isConnected || !entry.host.clientWidth || !entry.host.clientHeight) return;
  try {
    entry.fit.fit();
  } catch {
    /* the panel may be mid-layout */
  }
}

/** The user's Supabase access token, read fresh for every attempt. */
async function currentToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: 'Not connected',
  connecting: 'Starting the workspace…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
  unavailable: 'Unavailable',
};

export function ContainerTerminalView({ sessionId }: { sessionId: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const fontSize = useSettingsStore((s) => s.terminal.fontSize);
  const fontFamily = useSettingsStore((s) => s.editor.fontFamily);
  const theme = useMonacoTheme();
  const projectId = useFileStore((s) => s.meta?.id ?? null);

  const [state, setState] = useState<ConnectionState>('idle');
  const [detail, setDetail] = useState<string>('');

  useEffect(() => {
    const mount = mountRef.current;
    const url = gatewayUrl();
    if (!mount || !projectId || !url) return;

    const key = `${projectId}:${sessionId}`;
    let entry = live.get(key);

    if (!entry) {
      const host = document.createElement('div');
      host.style.height = '100%';
      host.style.width = '100%';

      const term = new Terminal({
        fontSize: Math.max(9, fontSize),
        fontFamily,
        cursorBlink: true,
        // Not `convertEol`: a PTY sends real CRLF, and translating it again
        // double-spaces everything a container prints.
        convertEol: false,
        scrollback: 5000,
        theme: theme === 'forge-light' ? TERMINAL_COLORS.light : TERMINAL_COLORS.dark,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      const decoder = new TextDecoder();
      // One sync engine per project, created before the client so the frame
      // handlers below can hand it the gateway's answers. Attaching is
      // idempotent: a second tab on this project joins the same engine.
      const sync = attachWorkspaceSync(projectId, {
        sendManifest: (files) => client.sendManifest(files),
        pushFiles: (files) => client.pushFiles(files),
        deleteFiles: (paths) => client.deleteFiles(paths),
        get containerId() {
          return client.containerId;
        },
      });

      const client: ContainerTerminalClient = new ContainerTerminalClient({
        gatewayUrl: url,
        projectId,
        token: currentToken,
        cols: term.cols,
        rows: term.rows,
        onOutput: (bytes) => term.write(decoder.decode(bytes, { stream: true })),
        onState: (next, why) => {
          setState(next);
          setDetail(why ?? '');
          // The container has a filesystem only once it is ready, and the
          // manifest is what establishes what is already on it. Sent here
          // rather than on mount because a reconnect needs it again: the
          // container may have been rebuilt while the tab was away.
          if (next === 'ready') void sync.start();
        },
        onExit: (code) => term.writeln(`\r\n\x1b[2m[process exited with code ${code ?? 0}]\x1b[0m`),
        onError: (_code, message) => term.writeln(`\r\n\x1b[31m${message}\x1b[0m`),
        onSyncPlan: (plan) => void sync.onPlan(plan),
        onSyncAck: (results) => sync.onAck(results),
        onSyncChanged: (files, deleted) => sync.onChanged(files, deleted),
        onSyncStorm: () => sync.onStorm(),
      });

      // Every keystroke, as typed. No line buffering: the PTY owns editing.
      term.onData((data) => client.write(data));
      term.onResize(({ cols, rows }) => client.resize(cols, rows));

      entry = { term, fit, host, client };
      live.set(key, entry);
      void client.connect();
    }

    mount.appendChild(entry.host);
    requestAnimationFrame(() => safeFit(entry!));
    entry.term.focus();
    setState(entry.client.connectionState);

    const onResize = () => safeFit(entry!);
    window.addEventListener('resize', onResize);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    observer?.observe(mount);

    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      // Detach the DOM node, not the session: the shell and anything it is
      // running stay alive on the gateway.
      entry?.host.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId]);

  useEffect(() => {
    const entry = live.get(`${projectId}:${sessionId}`);
    if (!entry) return;
    entry.term.options.theme = theme === 'forge-light' ? TERMINAL_COLORS.light : TERMINAL_COLORS.dark;
    entry.term.options.fontSize = Math.max(9, fontSize);
    entry.term.options.fontFamily = fontFamily;
    safeFit(entry);
  }, [sessionId, projectId, theme, fontSize, fontFamily]);

  if (!gatewayUrl()) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-ink-muted">
        <span>
          This deployment has no container infrastructure configured, so the Linux terminal is
          unavailable. The virtual terminal works as it always has.
        </span>
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-ink-muted">
        <span>Open a project to start a Linux terminal.</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {state !== 'ready' && (
        <div
          role="status"
          className={cx(
            'flex shrink-0 items-center gap-2 border-b border-line px-2 py-1 text-sm',
            state === 'unavailable' ? 'text-danger' : 'text-ink-muted',
          )}
        >
          <span>{detail || STATE_LABEL[state]}</span>
        </div>
      )}
      <div
        ref={mountRef}
        onMouseUp={() => {
          const entry = live.get(`${projectId}:${sessionId}`);
          if (entry && !window.getSelection()?.toString()) entry.term.focus();
        }}
        className="min-h-0 flex-1 px-2"
      />
    </div>
  );
}

/**
 * End every container session for a project.
 *
 * Called when a project closes: a workspace belongs to a project, and carrying
 * its shells into the next one would be both confusing and wrong.
 */
export function disposeContainerTerminals(projectId?: string): void {
  detachWorkspaceSync(projectId);
  for (const [key, entry] of live) {
    if (projectId && !key.startsWith(`${projectId}:`)) continue;
    entry.client.disconnect();
    entry.term.dispose();
    live.delete(key);
  }
}
