import { useMemo, useState } from 'react';
import { AlertCircle, Activity, Info, Sparkles, TriangleAlert, WifiOff } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { useConsoleStore } from '@/stores/consoleStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useTerminalStore, ENVIRONMENT_LABEL } from '@/stores/terminalStore';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';
import {
  SOURCE_LABEL,
  filterEvents,
  fromAgent,
  fromBuild,
  fromConsole,
  fromTerminals,
  groupErrors,
  incidentPrompt,
  mergeTimeline,
  sourceAvailability,
  type EventLevel,
  type EventSource,
  type TimelineEvent,
} from '@/lib/observability/timeline';
import { cx, formatClock } from '@/lib/utils';

/**
 * One account of what has happened, from the things TA CODE already observes.
 *
 * Nothing new is collected. The preview's console, the bundler's diagnostics,
 * each terminal's output and the agent's tool calls are merged into one ordered
 * list, so "what happened just before that error" is answerable without opening
 * four panels and comparing them by eye.
 *
 * Every row says which source it came from, because they are different
 * machines: a failure in the Linux Terminal says nothing about the project, and
 * a timeline that blurs that invites a conclusion drawn from the wrong one.
 *
 * The sources strip is the honest part. A source with nothing to report and a
 * source that is not connected look identical as an empty list and mean
 * opposite things, so this says which is which — deployments, here, have no
 * infrastructure to report from and say so rather than showing zero.
 */

const LEVEL_ICON = { error: AlertCircle, warn: TriangleAlert, info: Info, debug: Info };
const LEVEL_TONE: Record<EventLevel, string> = {
  error: 'text-danger',
  warn: 'text-caution',
  info: 'text-ink-muted',
  debug: 'text-ink-faint',
};

const ALL_SOURCES: EventSource[] = ['preview', 'build', 'ide', 'terminal', 'agent'];
const ALL_LEVELS: EventLevel[] = ['error', 'warn', 'info', 'debug'];

export function ObservabilityPanel() {
  const entries = useConsoleStore((s) => s.entries);
  const preview = usePreviewStore();
  const sessions = useTerminalStore((s) => s.sessions);
  const task = useAgentStore((s) => s.task);
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);

  const [sources, setSources] = useState<Set<EventSource>>(() => new Set(ALL_SOURCES));
  const [levels, setLevels] = useState<Set<EventLevel>>(() => new Set(ALL_LEVELS));
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'timeline' | 'errors' | 'sources'>('timeline');
  const [expanded, setExpanded] = useState<string | null>(null);

  const events = useMemo<TimelineEvent[]>(() => {
    const now = Date.now();
    return mergeTimeline(
      fromConsole(entries),
      fromBuild(
        {
          status: preview.status,
          entry: preview.entry,
          lastBuildMs: preview.lastBuildMs,
          errors: preview.errors,
          warnings: preview.warnings,
          buildToken: preview.buildToken,
        },
        now,
      ),
      fromTerminals(sessions, ENVIRONMENT_LABEL),
      fromAgent(task?.activities ?? [], now),
    );
  }, [
    entries,
    preview.status,
    preview.entry,
    preview.lastBuildMs,
    preview.errors,
    preview.warnings,
    preview.buildToken,
    sessions,
    task?.activities,
  ]);

  const visible = useMemo(
    () => filterEvents(events, { sources, levels, query }),
    [events, sources, levels, query],
  );
  const groups = useMemo(() => groupErrors(events), [events]);
  const availability = useMemo(() => sourceAvailability(events), [events]);
  const errorCount = events.filter((event) => event.level === 'error').length;

  const toggle = <T,>(set: Set<T>, value: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Observability"
        actions={
          errorCount > 0 ? <Badge tone="danger">{errorCount} errors</Badge> : <Badge>quiet</Badge>
        }
      />

      <div role="tablist" aria-label="Observability view" className="flex shrink-0 border-b border-line">
        {(
          [
            ['timeline', 'Timeline'],
            ['errors', 'Errors'],
            ['sources', 'Sources'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cx(
              'tap-target flex-1 px-2 py-1.5 text-sm transition-colors',
              tab === value
                ? 'border-b-2 border-accent text-ink'
                : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'timeline' && (
        <div className="shrink-0 space-y-1.5 border-b border-line px-2.5 py-1.5">
          <input
            aria-label="Search events"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search events"
            className="h-6 w-full rounded border border-line bg-surface-sunken px-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap gap-1">
            {ALL_SOURCES.map((source) => (
              <button
                key={source}
                type="button"
                aria-pressed={sources.has(source)}
                onClick={() => toggle(sources, source, setSources)}
                className={cx(
                  'tap-target rounded border px-1.5 py-0.5 text-sm transition-colors',
                  sources.has(source)
                    ? 'border-line-strong text-ink'
                    : 'border-line text-ink-faint opacity-60',
                )}
              >
                {SOURCE_LABEL[source]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {ALL_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={levels.has(level)}
                onClick={() => toggle(levels, level, setLevels)}
                className={cx(
                  'tap-target rounded border px-1.5 py-0.5 text-sm capitalize transition-colors',
                  levels.has(level)
                    ? cx('border-line-strong', LEVEL_TONE[level])
                    : 'border-line text-ink-faint opacity-60',
                )}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'timeline' &&
          (!visible.length ? (
            <EmptyState
              icon={<Activity className="h-4 w-4" />}
              title={events.length ? 'Nothing matches this filter' : 'Nothing recorded yet'}
              description={
                events.length
                  ? `${events.length} events hidden by the current filter.`
                  : 'Run the project, use a terminal or ask the assistant, and what happens appears here.'
              }
            />
          ) : (
            visible.slice(0, 400).map((event) => {
              const Icon = LEVEL_ICON[event.level];
              const open = expanded === event.id;
              return (
                <div key={event.id} className="border-b border-line">
                  <button
                    type="button"
                    aria-expanded={event.detail ? open : undefined}
                    onClick={() => setExpanded(open ? null : event.id)}
                    className="flex w-full items-start gap-2 px-2.5 py-1 text-left hover:bg-surface-raised"
                  >
                    <Icon
                      aria-hidden
                      className={cx('mt-0.5 h-3 w-3 shrink-0', LEVEL_TONE[event.level])}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-base text-ink-muted">
                        {event.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
                        <span className="rounded-sm border border-line px-1">
                          {SOURCE_LABEL[event.source]}
                        </span>
                        {event.origin && <span className="truncate font-mono">{event.origin}</span>}
                        {/* Terminal lines carry no timestamp; showing a made-up
                            one would let them interleave plausibly and wrongly. */}
                        {event.at > 0 && (
                          <span className="tabular-nums">{formatClock(event.at)}</span>
                        )}
                      </span>
                    </span>
                  </button>
                  {open && event.detail && (
                    <pre className="scrollbar-thin overflow-x-auto border-t border-line bg-surface-sunken p-2 font-mono text-sm text-ink-muted">
                      {event.detail}
                    </pre>
                  )}
                </div>
              );
            })
          ))}

        {tab === 'errors' &&
          (!groups.length ? (
            <EmptyState title="No errors recorded" description="Nothing has failed since this session started." />
          ) : (
            groups.map((group) => (
              <div key={group.key} className="border-b border-line px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-base text-ink">{group.first.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
                      <span className="rounded-sm border border-line px-1">
                        {SOURCE_LABEL[group.first.source]}
                      </span>
                      {group.first.origin && (
                        <span className="truncate font-mono">{group.first.origin}</span>
                      )}
                    </p>
                  </div>
                  <Badge tone="danger">×{group.count}</Badge>
                </div>
                <Button
                  size="xs"
                  className="mt-1.5"
                  disabled={running}
                  leading={<Sparkles className="h-3 w-3" />}
                  onClick={() => {
                    // The ordinary agent, with the events that were actually
                    // recorded. It is asked to say so when they are not enough
                    // rather than to produce a cause that fits.
                    setSidebarPanel('assistant');
                    void send(incidentPrompt(group, events));
                  }}
                >
                  Explain this
                </Button>
              </div>
            ))
          ))}

        {tab === 'sources' && (
          <div className="py-1">
            {availability.map((source) => (
              <div
                key={source.source}
                className="flex items-start gap-2 border-b border-line px-2.5 py-1.5"
              >
                {source.available ? (
                  <Activity aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-positive" />
                ) : (
                  <WifiOff aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-base text-ink">{source.label}</p>
                  <p className="text-sm text-ink-faint">
                    {source.available ? (
                      <span>
                        {source.count} event{source.count === 1 ? '' : 's'} collected this session.
                      </span>
                    ) : (
                      <span>{source.reason}</span>
                    )}
                  </p>
                </div>
                <Badge tone={source.available ? 'neutral' : 'caution'}>
                  {source.available ? 'collecting' : 'unavailable'}
                </Badge>
              </div>
            ))}
            <p className="px-2.5 py-2 text-sm text-ink-faint">
              <span>
                Everything here is collected in this browser during this session. There is no
                server-side telemetry, so nothing survives a reload and nothing is reported from
                production.
              </span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
