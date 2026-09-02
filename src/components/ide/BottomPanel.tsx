import { useEffect, useMemo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  Info,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState, Badge } from '@/components/ui/Primitives';
import { TerminalView } from '@/components/ide/TerminalView';
import { FileIcon } from '@/components/ide/FileIcon';
import { useUIStore, type BottomTab } from '@/stores/uiStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useEditorStore } from '@/stores/editorStore';
import { useConsoleStore, ALL_LEVELS } from '@/stores/consoleStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Problem } from '@/types';
import { cx, formatClock } from '@/lib/utils';
import { basename } from '@/lib/vfs';

const SEVERITY_ICON = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const SEVERITY_TONE = {
  error: 'text-danger',
  warning: 'text-caution',
  info: 'text-accent',
};

function ProblemsList() {
  const problems = useEditorStore((s) => s.problems);
  const reveal = useEditorStore((s) => s.revealLocation);
  const buildErrors = usePreviewStore((s) => s.errors);

  const combined: Problem[] = useMemo(
    () => [
      ...buildErrors
        .filter((error) => error.path)
        .map((error, index) => ({
          id: `build-${index}`,
          path: error.path,
          line: error.line,
          column: error.column,
          endLine: error.line,
          endColumn: error.column,
          severity: 'error' as const,
          message: error.message,
          source: 'esbuild',
        })),
      ...problems,
    ],
    [problems, buildErrors],
  );

  if (!combined.length) {
    return <EmptyState title="No problems detected" description="Diagnostics appear here as you type and build." />;
  }

  return (
    <ul className="scrollbar-thin h-full overflow-y-auto py-1">
      {combined.map((problem) => {
        const Icon = SEVERITY_ICON[problem.severity];
        return (
          <li key={problem.id}>
            <button
              type="button"
              onClick={() => reveal(problem.path, problem.line, problem.column)}
              className="flex w-full items-start gap-2 px-3 py-1 text-left text-base transition-colors hover:bg-surface-raised"
            >
              <Icon className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', SEVERITY_TONE[problem.severity])} />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-ink">{problem.message}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-faint">
                  <FileIcon path={problem.path} />
                  {basename(problem.path)}
                  <span>
                    [{problem.line}, {problem.column}]
                  </span>
                  <span className="rounded-sm border border-line px-1">{problem.source}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OutputList() {
  const { entries, filter, query, toggleLevel, setQuery, clear } = useConsoleStore();
  const visible = entries.filter(
    (entry) =>
      filter.has(entry.level) &&
      (!query || entry.message.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1">
        <input
          aria-label="Filter output"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
          className="h-6 w-40 rounded border border-line bg-surface-sunken px-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <div className="flex gap-0.5">
          {ALL_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={filter.has(level)}
              onClick={() => toggleLevel(level)}
              className={cx(
                'rounded-sm px-1.5 py-0.5 text-2xs uppercase tracking-wider transition-colors',
                filter.has(level)
                  ? 'bg-surface-raised text-ink'
                  : 'text-ink-faint hover:text-ink-muted',
              )}
            >
              {level}
            </button>
          ))}
        </div>
        <IconButton
          label="Clear output"
          size="xs"
          className="ml-auto"
          icon={<Trash2 className="h-3 w-3" />}
          onClick={clear}
        />
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto font-mono text-sm">
        {!visible.length ? (
          <EmptyState
            title="No output"
            description="Build results and console messages from the preview appear here."
          />
        ) : (
          visible.map((entry) => (
            <div
              key={entry.id}
              className={cx(
                'flex gap-2 border-b border-line/50 px-3 py-1',
                entry.level === 'error' && 'bg-danger/5',
                entry.level === 'warn' && 'bg-caution/5',
              )}
            >
              <span className="shrink-0 text-ink-faint">{formatClock(entry.timestamp)}</span>
              <span
                className={cx(
                  'w-14 shrink-0 uppercase',
                  entry.channel === 'build' ? 'text-accent' : 'text-ink-faint',
                )}
              >
                {entry.channel}
              </span>
              <span
                className={cx(
                  'min-w-0 flex-1 whitespace-pre-wrap break-words',
                  entry.level === 'error'
                    ? 'text-danger'
                    : entry.level === 'warn'
                      ? 'text-caution'
                      : 'text-ink',
                )}
              >
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PortsPanel() {
  const status = usePreviewStore((s) => s.status);
  const entry = usePreviewStore((s) => s.entry);
  const bundledPackages = usePreviewStore((s) => s.bundledPackages);
  const externals = usePreviewStore((s) => s.externals);
  const port = useSettingsStore((s) => s.runtime.devServerPort);
  const cdn = useSettingsStore((s) => s.runtime.esmCdn);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-3">
      <table className="w-full text-base">
        <thead>
          <tr className="text-left text-sm text-ink-faint">
            <th className="pb-2 font-normal">Runtime</th>
            <th className="pb-2 font-normal">Address</th>
            <th className="pb-2 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line">
            <td className="py-2 text-ink">Preview sandbox</td>
            <td className="py-2 font-mono text-ink-muted">srcdoc (opaque origin)</td>
            <td className="py-2">
              <Badge tone={status === 'running' ? 'positive' : 'neutral'}>{status}</Badge>
            </td>
          </tr>
          <tr className="border-t border-line">
            <td className="py-2 text-ink">Entry point</td>
            <td className="py-2 font-mono text-ink-muted">{entry || '—'}</td>
            <td className="py-2 text-ink-faint">bundled by esbuild-wasm</td>
          </tr>
          <tr className="border-t border-line">
            <td className="py-2 align-top text-ink">Local packages</td>
            <td className="py-2 font-mono text-ink-muted">
              {bundledPackages.length ? bundledPackages.join(', ') : '—'}
            </td>
            <td className="py-2 align-top text-ink-faint">served from this origin, no network</td>
          </tr>
          <tr className="border-t border-line">
            <td className="py-2 align-top text-ink">CDN packages</td>
            <td className="py-2 font-mono text-ink-muted">
              {externals.length ? externals.join(', ') : '—'}
            </td>
            <td className="py-2 align-top text-ink-faint">
              {externals.length ? `fetched from ${cdn}` : 'none required'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-4 text-sm text-ink-faint">
        The preview runs inside this page, not on a TCP port. Port {port} in settings applies when
        you run the project locally with a real dev server; nothing in the browser listens on it.
      </p>
    </div>
  );
}

export function BottomPanel() {
  const { bottomTab, setBottomTab, toggleBottom } = useUIStore();
  const { sessions, activeId, createSession, ensureSession, killSession, setActive } =
    useTerminalStore();
  const problemCount = useEditorStore((s) => s.problems.filter((p) => p.severity === 'error').length);
  const warningCount = useEditorStore((s) => s.problems.filter((p) => p.severity === 'warning').length);

  useEffect(() => {
    ensureSession();
  }, [ensureSession]);

  const tabs: Array<{ id: BottomTab; label: string; badge?: number; tone?: 'danger' | 'caution' }> = [
    { id: 'terminal', label: 'Terminal' },
    {
      id: 'problems',
      label: 'Problems',
      badge: problemCount || warningCount,
      tone: problemCount ? 'danger' : 'caution',
    },
    { id: 'output', label: 'Output' },
    { id: 'ports', label: 'Runtime' },
  ];

  return (
    <section aria-label="Panel" className="flex h-full flex-col border-t border-line bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <div role="tablist" aria-label="Panel tabs" className="flex">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={bottomTab === tab.id}
              onClick={() => setBottomTab(tab.id)}
              className={cx(
                'flex items-center gap-1.5 px-2.5 py-1 text-sm uppercase tracking-wider transition-colors',
                bottomTab === tab.id
                  ? 'border-b-2 border-accent text-ink'
                  : 'border-b-2 border-transparent text-ink-faint hover:text-ink',
              )}
            >
              {tab.label}
              {Boolean(tab.badge) && (
                <span
                  className={cx(
                    'rounded-sm px-1 text-2xs',
                    tab.tone === 'danger' ? 'bg-danger/20 text-danger' : 'bg-caution/20 text-caution',
                  )}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {bottomTab === 'terminal' && (
          <div className="ml-3 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={cx(
                  'group flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 text-sm transition-colors',
                  session.id === activeId
                    ? 'bg-surface-raised text-ink'
                    : 'text-ink-faint hover:text-ink',
                )}
              >
                <button type="button" onClick={() => setActive(session.id)}>
                  {session.name}
                </button>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Kill ${session.name}`}
                    onClick={() => killSession(session.id)}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            <IconButton
              label="New terminal"
              size="xs"
              icon={<Plus className="h-3 w-3" />}
              onClick={() => createSession()}
            />
          </div>
        )}

        <IconButton
          label="Collapse panel"
          className="ml-auto"
          icon={<ChevronDown className="h-3.5 w-3.5" />}
          onClick={() => toggleBottom(false)}
        />
      </div>

      <div className="min-h-0 flex-1">
        {bottomTab === 'terminal' &&
          (activeId ? (
            <TerminalView key={activeId} sessionId={activeId} />
          ) : (
            <EmptyState title="No terminal" />
          ))}
        {bottomTab === 'problems' && <ProblemsList />}
        {bottomTab === 'output' && <OutputList />}
        {bottomTab === 'ports' && <PortsPanel />}
      </div>
    </section>
  );
}

