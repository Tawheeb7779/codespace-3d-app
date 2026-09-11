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
import {
  registerProjectWorkspace,
  resolveWorkspaceRequest,
} from '@/lib/ai/workspaceBridge';
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
  /** Kept here, not only in React state, so a remount can show them at once. */
  ports: Array<{ port: number; url: string }>;
  /**
   * Where port updates go, reassigned on each mount.
   *
   * The client outlives the component — that is the point of the `live` map —
   * so a `setState` captured when the client was created belongs to an
   * instance that may be gone. Routing through the entry means the currently
   * mounted panel is always the one that hears.
   */
  onPorts: (ports: Array<{ port: number; url: string }>) => void;
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

/**
 * Open a discovered port in a new tab.
 *
 * The token is fetched at click time and never stored in the DOM: a link whose
 * `href` carries a session token puts it in the page source, in the middle-click
 * menu, and in anything that scrapes the document. The proxy accepts it as a
 * query parameter because a browser cannot set a header on a top-level
 * navigation — that much is unavoidable — but a token that exists only for the
 * duration of one `window.open` is a much smaller thing than one that sits in
 * the markup for as long as the panel is open.
 *
 * `noopener` because the container's development server is a different origin
 * and must not be handed a reference back to the IDE.
 */
async function openPort(path: string): Promise<void> {
  const gateway = gatewayUrl();
  if (!gateway) return;
  const token = await currentToken();
  if (!token) return;
  const base = gateway.replace(/^ws/, 'http').replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  url.searchParams.set('access_token', token);
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: 'Not connected',
  connecting: 'Starting the workspace…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
  unavailable: 'Unavailable',
};

export function ContainerTerminalView({
  sessionId,
  kind = 'project',
}: {
  sessionId: string;
  /**
   * Which workspace this terminal opens.
   *
   * `project` is the open project in a container: its files are synchronised
   * in, and it is authorised by project membership. `linux` is the person's own
   * workspace — no project, no sync, nothing mounted — and it is authorised by
   * identity alone. They are separate containers with separate directories.
   */
  kind?: 'project' | 'linux';
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const fontSize = useSettingsStore((s) => s.terminal.fontSize);
  const fontFamily = useSettingsStore((s) => s.editor.fontFamily);
  const theme = useMonacoTheme();
  const projectId = useFileStore((s) => s.meta?.id ?? null);

  const [state, setState] = useState<ConnectionState>('idle');
  const [detail, setDetail] = useState<string>('');
  const [ports, setPorts] = useState<Array<{ port: number; url: string }>>([]);

  useEffect(() => {
    const mount = mountRef.current;
    const url = gatewayUrl();
    // A Linux workspace does not need a project open, and must not be keyed by
    // one: it is the same workspace whichever project the editor is showing,
    // and keying it by project would start a second container per project —
    // which is exactly the coupling this feature exists to avoid.
    const scope = kind === 'linux' ? 'linux' : projectId;
    if (!mount || !scope || !url) return;

    // The kind is in the key: a project terminal and a Linux terminal are two
    // different workspaces, and sharing one live entry would show one's output
    // in the other.
    const key = `${kind}:${scope}:${sessionId}`;
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
      /**
       * File sync belongs to a project terminal and to nothing else.
       *
       * A Linux workspace deliberately holds no project: syncing the editor's
       * files into it would be the automatic mount the architecture forbids.
       * Files reach it only through an explicit transfer, so this is null for
       * `linux` and every sync handler below is a no-op.
       */
      const sync =
        kind === 'linux' || !projectId
          ? null
          : attachWorkspaceSync(projectId, {
              sendManifest: (files) => client.sendManifest(files),
              pushFiles: (files) => client.pushFiles(files),
              deleteFiles: (paths) => client.deleteFiles(paths),
              get containerId() {
                return client.containerId;
              },
            });

      const client: ContainerTerminalClient = new ContainerTerminalClient({
        gatewayUrl: url,
        // A Linux workspace has no project id, and sending one is refused by
        // the gateway rather than ignored.
        projectId: kind === 'linux' ? '' : (projectId ?? ''),
        kind,
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
          if (next === 'ready') {
            void sync?.start();
            /**
             * The agent works on the project, so only a project workspace is
             * registered. Registering a Linux workspace here would quietly give
             * the agent a shell environment that holds none of the project's
             * files and is not what any of its tools mean.
             */
            if (kind === 'project') registerProjectWorkspace(client);
          }
        },
        onExit: (code) => term.writeln(`\r\n\x1b[2m[process exited with code ${code ?? 0}]\x1b[0m`),
        onError: (_code, message) => term.writeln(`\r\n\x1b[31m${message}\x1b[0m`),
        onSyncPlan: (plan) => void sync?.onPlan(plan),
        onSyncAck: (results) => sync?.onAck(results),
        onSyncChanged: (files, deleted) => sync?.onChanged(files, deleted),
        onSyncStorm: () => sync?.onStorm(),
        // Answers to the agent's git and check requests. Routed by request id
        // rather than by order, because several can be in flight.
        onGitResult: (result) => resolveWorkspaceRequest(result.requestId, result),
        onCheckResult: (result) => resolveWorkspaceRequest(result.requestId, result),
        onPorts: (next) => {
          const current = live.get(key);
          if (!current) return;
          current.ports = next;
          current.onPorts(next);
        },
      });

      // Every keystroke, as typed. No line buffering: the PTY owns editing.
      term.onData((data) => client.write(data));
      term.onResize(({ cols, rows }) => client.resize(cols, rows));

      entry = { term, fit, host, client, ports: [], onPorts: () => undefined };
      live.set(key, entry);
      void client.connect();
    }

    mount.appendChild(entry.host);
    requestAnimationFrame(() => safeFit(entry!));
    entry.term.focus();
    setState(entry.client.connectionState);
    // A panel reopened onto a running container has ports already; they arrive
    // again on the next sweep, but not instantly, and an empty strip in the
    // meantime reads as "the server stopped".
    setPorts(entry.ports);
    entry.onPorts = setPorts;

    const onResize = () => safeFit(entry!);
    window.addEventListener('resize', onResize);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    observer?.observe(mount);

    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      if (entry) entry.onPorts = () => undefined;
      // The agent must not hold a client for a panel that is gone: its next
      // request would wait for an answer nobody is going to send.
      if (kind === 'project') registerProjectWorkspace(null);
      // Detach the DOM node, not the session: the shell and anything it is
      // running stay alive on the gateway.
      entry?.host.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId, kind]);

  useEffect(() => {
    const entry = live.get(`${kind}:${kind === 'linux' ? 'linux' : projectId}:${sessionId}`);
    if (!entry) return;
    entry.term.options.theme = theme === 'forge-light' ? TERMINAL_COLORS.light : TERMINAL_COLORS.dark;
    entry.term.options.fontSize = Math.max(9, fontSize);
    entry.term.options.fontFamily = fontFamily;
    safeFit(entry);
  }, [sessionId, projectId, kind, theme, fontSize, fontFamily]);

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

  // A Linux workspace needs no project; a project terminal does.
  if (!projectId && kind === 'project') {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-ink-muted">
        <span>Open a project to start a project terminal.</span>
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
      {ports.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1">
          {/* Wrapped, because a bare text node beside the mapped list below is
              the reconciliation crash the audit scans for. */}
          <span className="text-xs text-ink-faint">Serving</span>
          {ports.map((entry) => (
            <button
              key={entry.port}
              type="button"
              onClick={() => void openPort(entry.url)}
              aria-label={`Open port ${entry.port} in a new tab`}
              className="tap-target rounded-[4px] bg-surface-sunken px-1.5 py-0.5 font-mono text-xs tabular-nums text-accent outline-none hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span>{`:${entry.port}`}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={mountRef}
        onMouseUp={() => {
          const entry = live.get(`${kind}:${kind === 'linux' ? 'linux' : projectId}:${sessionId}`);
          if (entry && !window.getSelection()?.toString()) entry.term.focus();
        }}
        className="min-h-0 flex-1 px-2"
      />
    </div>
  );
}

/**
 * A connected workspace of one kind, for code outside the terminal to use.
 *
 * The Linux Files panel needs the Linux workspace's client and the project
 * workspace's container id at the same time, and both live here because the
 * client outlives the component that created it. Exposed as a lookup rather
 * than by handing the map out: a caller names the kind it wants, so nothing
 * outside this module can confuse the two workspaces — which is the boundary
 * the whole design rests on.
 *
 * Returns null when that kind has no connected workspace. A caller must report
 * that rather than wait, because "not connected" is a true answer.
 */
export function liveWorkspace(
  kind: 'project' | 'linux',
  projectId?: string,
): { client: ContainerTerminalClient; containerId: string } | null {
  const scope = kind === 'linux' ? 'linux' : projectId;
  if (!scope) return null;
  for (const [key, entry] of live) {
    if (!key.startsWith(`${kind}:${scope}:`)) continue;
    // The id comes back with the gateway's `ready` frame, so a connecting
    // workspace has none yet and is not usable for a transfer.
    const containerId = entry.client.containerId;
    if (containerId) return { client: entry.client, containerId };
  }
  return null;
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
    // Only this project's terminals. A Linux workspace does not belong to the
    // project being closed and must survive switching between projects — that
    // independence is the point of it.
    if (projectId && !key.startsWith(`project:${projectId}:`)) continue;
    if (!projectId && key.startsWith('linux:')) continue;
    entry.client.disconnect();
    entry.term.dispose();
    live.delete(key);
  }
}
