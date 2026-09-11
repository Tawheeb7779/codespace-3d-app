import { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Download,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  RefreshCw,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState, Badge } from '@/components/ui/Primitives';
import { Menu } from '@/components/ui/Menu';
import { TerminalView } from '@/components/ide/TerminalView';
import { ChecksPanel } from '@/components/ide/ChecksPanel';
import { FileIcon } from '@/components/ide/FileIcon';
import { useUIStore, type BottomTab } from '@/stores/uiStore';
import {
  useTerminalStore,
  ENVIRONMENT_LABEL,
  TERMINAL_ENVIRONMENTS,
} from '@/stores/terminalStore';
import { containerTerminalAvailable } from '@/lib/terminal/containerClient';
import { useEditorStore } from '@/stores/editorStore';
import { useConsoleStore, ALL_LEVELS } from '@/stores/consoleStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useAiStore } from '@/stores/aiStore';
import { useFileStore } from '@/stores/fileStore';
import { fixPrompt } from '@/lib/ai/fixPrompt';
import type { Problem } from '@/types';
import { useSettingsStore } from '@/stores/settingsStore';
import { useIsMobile } from '@/hooks/useMediaQuery';
import {
  DEFAULT_PROBLEM_FILTER,
  buildProblems,
  countBySeverity,
  filterProblems,
  groupProblems,
  mergeProblems,
  nextProblem,
  type ProblemFilter,
} from '@/lib/problems';
import { cx, errorMessage, formatClock } from '@/lib/utils';
import { downloadText } from '@/lib/archive';
import { toast } from '@/stores/toastStore';
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
  const cursor = useEditorStore((s) => s.cursor);
  const activePath = useEditorStore((s) => s.activePath);
  const buildErrors = usePreviewStore((s) => s.errors);
  const buildWarnings = usePreviewStore((s) => s.warnings);
  const refresh = usePreviewStore((s) => s.refresh);
  const [filter, setFilter] = useState<ProblemFilter>(DEFAULT_PROBLEM_FILTER);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const aiRunning = useAiStore((s) => s.running);

  /**
   * Hand one diagnostic to the assistant, with its source.
   *
   * The same `send` the assistant panel uses, so this is one conversation
   * rather than a second path into the model; the panel is brought forward
   * because a request whose answer appears somewhere the user is not looking
   * reads as nothing having happened.
   */
  const askToFix = async (problem: Problem) => {
    const files = useFileStore.getState().files;
    useUIStore.getState().setSidebarPanel('assistant');
    await useAiStore.getState().send(fixPrompt(problem, files));
  };

  // One ordered list, from both real sources: the language workers and the
  // bundler. Everything below — counts, groups, navigation — reads this.
  const all = useMemo(
    () =>
      mergeProblems([
        buildProblems(buildErrors),
        buildProblems(buildWarnings),
        problems,
      ]),
    [problems, buildErrors, buildWarnings],
  );
  const counts = useMemo(() => countBySeverity(all), [all]);
  const visible = useMemo(() => filterProblems(all, filter), [all, filter]);
  const groups = useMemo(() => groupProblems(visible), [visible]);

  const jump = (direction: 1 | -1) => {
    const target = nextProblem(
      visible,
      activePath ? { path: activePath, line: cursor.line, column: cursor.column } : null,
      direction,
    );
    if (target) reveal(target.path, target.line, target.column);
  };

  const toggleGroup = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1">
        {(
          [
            ['errors', 'error', counts.error],
            ['warnings', 'warning', counts.warning],
            ['info', 'info', counts.info],
          ] as const
        ).map(([key, severity, count]) => {
          const Icon = SEVERITY_ICON[severity];
          return (
            <button
              key={key}
              type="button"
              aria-pressed={filter[key]}
              onClick={() => setFilter((current) => ({ ...current, [key]: !current[key] }))}
              className={cx(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-sm transition-colors',
                filter[key]
                  ? 'border-line-strong text-ink'
                  : 'border-line text-ink-faint opacity-60',
              )}
            >
              <Icon className={cx('h-3 w-3', SEVERITY_TONE[severity])} />
              {count}
            </button>
          );
        })}

        <input
          aria-label="Filter problems"
          value={filter.query}
          onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
          placeholder="Filter"
          className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />

        <IconButton
          size="xs"
          label="Previous problem"
          icon={<ChevronUp className="h-3 w-3" />}
          disabled={!visible.length}
          onClick={() => jump(-1)}
        />
        <IconButton
          size="xs"
          label="Next problem"
          icon={<ChevronDown className="h-3 w-3" />}
          disabled={!visible.length}
          onClick={() => jump(1)}
        />
        <IconButton
          size="xs"
          label="Rebuild to refresh problems"
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => void refresh()}
        />
      </div>

      {!visible.length ? (
        <EmptyState
          title={all.length ? 'No problems match this filter' : 'No problems detected'}
          description={
            all.length
              ? `${all.length} problem${all.length === 1 ? '' : 's'} hidden by the current filter.`
              : 'Diagnostics appear here as you type and build.'
          }
        />
      ) : (
        <div className="scrollbar-thin flex-1 overflow-y-auto py-1">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.path);
            return (
              <section key={group.path}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(group.path)}
                  className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-sm hover:bg-surface-raised"
                >
                  <ChevronDown
                    aria-hidden
                    className={cx(
                      'h-3 w-3 shrink-0 text-ink-faint transition-transform',
                      isCollapsed && '-rotate-90',
                    )}
                  />
                  <FileIcon path={group.path} />
                  <span className="truncate text-ink">{basename(group.path)}</span>
                  <span className="truncate text-ink-faint">{group.path}</span>
                  <span className="ml-auto shrink-0 text-ink-faint">{group.problems.length}</span>
                </button>

                {!isCollapsed &&
                  group.problems.map((problem) => {
                    const Icon = SEVERITY_ICON[problem.severity];
                    return (
                      <div
                        key={problem.id}
                        className="group/problem flex w-full items-start gap-2 py-1 pl-8 pr-3 transition-colors hover:bg-surface-raised"
                      >
                        <button
                          type="button"
                          onClick={() => reveal(problem.path, problem.line, problem.column)}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left text-base"
                        >
                          <Icon
                            className={cx(
                              'mt-0.5 h-3.5 w-3.5 shrink-0',
                              SEVERITY_TONE[problem.severity],
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-ink">{problem.message}</span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-faint">
                              <span>
                                [{problem.line}, {problem.column}]
                              </span>
                              <span className="rounded-sm border border-line px-1">
                                {problem.source}
                              </span>
                            </span>
                          </span>
                        </button>
                        {/*
                          The fix starts where the error is.
                          Otherwise somebody retypes the message into the
                          assistant without the path, and it fixes the wrong
                          file. This sends the real diagnostic and the real
                          source around it.
                        */}
                        <button
                          type="button"
                          disabled={aiRunning}
                          onClick={() => void askToFix(problem)}
                          className="tap-target mt-0.5 shrink-0 rounded border border-line px-1.5 py-0.5 text-sm text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/problem:opacity-100 disabled:cursor-not-allowed"
                          title="Ask the assistant to fix this"
                        >
                          <span>Fix</span>
                        </button>
                      </div>
                    );
                  })}
              </section>
            );
          })}
        </div>
      )}
    </div>
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
  const isMobile = useIsMobile();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const {
    sessions,
    activeId,
    createSession,
    ensureSession,
    killSession,
    setActive,
    renameSession,
    transcript,
  } = useTerminalStore();
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

  // The container's own checks, and only where a container can exist. With no
  // gateway configured the tab would open onto a permanent "not attached", so
  // it is not offered rather than offered and empty.
  if (containerTerminalAvailable()) tabs.splice(2, 0, { id: 'checks', label: 'Checks' });

  return (
    <section aria-label="Panel" className="flex h-full flex-col border-t border-line bg-surface">
      {/* The strip carries the four tabs and, on the terminal tab, the session
          controls. At phone width that is wider than the screen, and with no
          overflow rule the session tabs and the copy/download buttons were
          simply clipped away — unreachable rather than merely cramped. */}
      <div className="scrollbar-thin flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1.5">
        <div role="tablist" aria-label="Panel tabs" className="flex shrink-0">
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
            {/*
              * Which environment the commands run in.
              *
              * Shown only where there is a choice: a deployment with no
              * container gateway has one terminal, and a control offering an
              * option that cannot work is worse than no control.
              *
              * Three labels, because there are three things and the last two
              * are not the same thing. "Project" is the in-browser shell over
              * the project's files. "Project (Linux)" is the same project in a
              * real container. "Linux workspace" is not a project at all — it
              * belongs to the person, starts empty, and mounts nothing. Naming
              * the last two alike is how the boundary gets forgotten.
              */}
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
                {renaming === session.id ? (
                  <input
                    autoFocus
                    aria-label="Terminal name"
                    defaultValue={session.name}
                    onBlur={(event) => {
                      renameSession(session.id, event.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    className="w-20 rounded-sm border border-accent bg-surface-sunken px-1 text-sm text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    className="tap-target flex items-center gap-1"
                    aria-label={`${ENVIRONMENT_LABEL[session.environment]}: ${session.name}`}
                    onClick={() => setActive(session.id)}
                    onDoubleClick={() => setRenaming(session.id)}
                    title={`${ENVIRONMENT_LABEL[session.environment]} — double-click to rename`}
                  >
                    {/* The environment is on every tab, not in a selector
                        somewhere else: which machine a command lands on is the
                        one thing a person must never have to remember. */}
                    <span
                      aria-hidden
                      className={cx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        session.environment === 'linux'
                          ? 'bg-caution'
                          : session.environment === 'project-container'
                            ? 'bg-accent'
                            : 'bg-ink-faint',
                      )}
                    />
                    <span>{session.name}</span>
                  </button>
                )}
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
            {/*
              * One control that opens a terminal *somewhere*, rather than a
              * selector that moves every terminal at once. Each entry adds a
              * session; nothing already open is closed or replaced. With no
              * gateway there is one environment, so there is no menu — a menu
              * of one is a button wearing a hat.
              */}
            <IconButton
              label="New terminal"
              size="xs"
              icon={<Plus className="h-3 w-3" />}
              onClick={(event) => {
                if (!containerTerminalAvailable()) {
                  createSession('project');
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setNewMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            />
            <Menu
              label="New terminal environment"
              anchor={newMenu}
              onClose={() => setNewMenu(null)}
              items={TERMINAL_ENVIRONMENTS.map((environment) => ({
                id: environment,
                label: ENVIRONMENT_LABEL[environment],
                onSelect: () => createSession(environment),
              }))}
            />
            <IconButton
              label="Copy terminal output"
              size="xs"
              disabled={!activeId}
              icon={<Copy className="h-3 w-3" />}
              onClick={() => {
                if (!activeId) return;
                const text = transcript(activeId);
                if (!text) {
                  toast.info('Nothing to copy', 'This terminal has produced no output yet.');
                  return;
                }
                // Reporting the real outcome matters: the clipboard is refused
                // outright in some contexts, and a silent failure here would
                // look identical to a copy that worked.
                navigator.clipboard
                  .writeText(text)
                  .then(() => toast.success('Copied', `${text.split('\n').length} lines.`))
                  .catch((error) => toast.error('Could not copy', errorMessage(error)));
              }}
            />
            <IconButton
              label="Download terminal log"
              size="xs"
              disabled={!activeId}
              icon={<Download className="h-3 w-3" />}
              onClick={() => {
                if (!activeId) return;
                const session = sessions.find((entry) => entry.id === activeId);
                const text = transcript(activeId);
                if (!text) {
                  toast.info('Nothing to save', 'This terminal has produced no output yet.');
                  return;
                }
                downloadText(`${session?.name ?? 'terminal'}.log`, text);
              }}
            />
          </div>
        )}

        {/* On a phone this panel is a whole screen reached from the bottom
            navigation, and nothing there reads bottomOpen — collapsing would be
            a button that visibly does nothing, on the width least able to spare
            the room. */}
        {!isMobile && (
          <IconButton
            label="Collapse panel"
            className="ml-auto"
            icon={<ChevronDown className="h-3.5 w-3.5" />}
            onClick={() => toggleBottom(false)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1">
        {bottomTab === 'terminal' &&
          (activeId ? (
            <TerminalView key={activeId} sessionId={activeId} />
          ) : (
            <EmptyState title="No terminal" />
          ))}
        {bottomTab === 'problems' && <ProblemsList />}
        {bottomTab === 'checks' && <ChecksPanel />}
        {bottomTab === 'output' && <OutputList />}
        {bottomTab === 'ports' && <PortsPanel />}
      </div>
    </section>
  );
}

