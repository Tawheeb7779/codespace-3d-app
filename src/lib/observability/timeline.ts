import type { ConsoleEntry } from '@/types';
import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentActivity } from '@/lib/ai/agent';

/**
 * One timeline over everything TA CODE already observes.
 *
 * Nothing here collects anything new. The console buffer, the bundler's
 * diagnostics, each terminal's scrollback and the agent's activity log all
 * exist and are already written to by the parts of the app that produce them;
 * this merges them into one ordered account so a question like "what happened
 * just before that error" can be answered without opening four panels.
 *
 * **Every event says where it came from.** `source` is not decoration — a log
 * line from the sandboxed preview and a line from a Linux terminal are
 * different machines, and a timeline that blurs them invites a conclusion drawn
 * from the wrong one.
 *
 * **A source that is not configured is not an empty source.** Deployment
 * events, and production telemetry generally, need infrastructure this
 * deployment does not have. `sourceAvailability` reports that as unavailable
 * rather than as "no events", because those look identical on screen and mean
 * opposite things.
 *
 * These are pure functions over state the stores already hold, so nothing is
 * duplicated and the tests drive the real merge.
 */

export type EventSource =
  /** The sandboxed preview iframe: the running application's own console. */
  | 'preview'
  /** The in-browser bundler. */
  | 'build'
  /** TA CODE itself. */
  | 'ide'
  /** A terminal, of whichever environment. */
  | 'terminal'
  /** The AI agent's tool calls and verifications. */
  | 'agent'
  /** Deployment. Requires infrastructure this build has none of. */
  | 'deploy';

export type EventLevel = 'error' | 'warn' | 'info' | 'debug';

export interface TimelineEvent {
  id: string;
  at: number;
  source: EventSource;
  level: EventLevel;
  /** One line, the thing that happened. */
  title: string;
  /** Where it happened, when that is narrower than the source. */
  origin?: string;
  /** The full text, when there is more than the title. */
  detail?: string;
}

export interface SourceAvailability {
  source: EventSource;
  label: string;
  /** False when the source needs infrastructure that is not configured. */
  available: boolean;
  /** Why, when it is not available. */
  reason?: string;
  /** How many events this source contributed. */
  count: number;
}

const CONSOLE_LEVEL: Record<string, EventLevel> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  log: 'info',
  debug: 'debug',
};

/** Console entries, split by the channel that produced them. */
export function fromConsole(entries: ConsoleEntry[]): TimelineEvent[] {
  return entries.map((entry) => ({
    id: `console:${entry.id}`,
    at: entry.timestamp,
    // `preview` is the running app, `build` the bundler, `ide` this app. They
    // are three different origins and the channel already knows which.
    source: entry.channel === 'preview' ? 'preview' : entry.channel === 'build' ? 'build' : 'ide',
    level: CONSOLE_LEVEL[entry.level] ?? 'info',
    title: entry.message.split('\n')[0].slice(0, 300),
    detail: entry.message.includes('\n') ? entry.message : undefined,
  }));
}

export interface BuildSignal {
  status: string;
  entry: string;
  lastBuildMs: number;
  errors: Array<{ path: string; line: number; column: number; message: string }>;
  warnings: Array<{ path: string; line: number; column: number; message: string }>;
  /** Bumped on each completed build, and used here as its identity. */
  buildToken: number;
}

/**
 * The last build, as events.
 *
 * The preview store keeps the *current* build rather than a history, so this
 * describes one build and says so. Inventing a series from a single snapshot
 * would be fabricating the thing the panel is for.
 */
export function fromBuild(signal: BuildSignal, at: number): TimelineEvent[] {
  if (signal.status === 'idle') return [];
  const events: TimelineEvent[] = [];

  for (const error of signal.errors.slice(0, 50)) {
    events.push({
      id: `build-error:${signal.buildToken}:${error.path}:${error.line}:${error.column}`,
      at,
      source: 'build',
      level: 'error',
      title: error.message.split('\n')[0].slice(0, 300),
      origin: `${error.path}:${error.line}:${error.column}`,
      detail: error.message,
    });
  }
  for (const warning of signal.warnings.slice(0, 50)) {
    events.push({
      id: `build-warn:${signal.buildToken}:${warning.path}:${warning.line}:${warning.column}`,
      at,
      source: 'build',
      level: 'warn',
      title: warning.message.split('\n')[0].slice(0, 300),
      origin: `${warning.path}:${warning.line}:${warning.column}`,
      detail: warning.message,
    });
  }

  if (signal.status === 'running' || signal.status === 'error') {
    events.push({
      id: `build:${signal.buildToken}`,
      at,
      source: 'build',
      level: signal.status === 'error' ? 'error' : 'info',
      title:
        signal.status === 'error'
          ? `Build failed with ${signal.errors.length} error${signal.errors.length === 1 ? '' : 's'}`
          : `Build succeeded in ${signal.lastBuildMs}ms`,
      origin: signal.entry || undefined,
    });
  }
  return events;
}

/**
 * Terminal output, with the environment it came from.
 *
 * The environment is the `origin`, because a command that failed in the Linux
 * Terminal says nothing about the project and reading it as though it did is
 * the specific mistake the two-terminal architecture exists to prevent.
 *
 * Only the recent tail of each session: a terminal's scrollback is unbounded
 * by design and a timeline is not the place to re-render all of it.
 */
export function fromTerminals(
  sessions: TerminalSession[],
  labels: Record<string, string>,
  perSession = 40,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const session of sessions) {
    const lines = session.lines.slice(-perSession);
    const base = session.lines.length - lines.length;
    lines.forEach((line, index) => {
      if (!line.text.trim()) return;
      events.push({
        // No timestamp is kept per line, so ordering within a session is its
        // index. Said plainly rather than a fabricated clock reading.
        id: `term:${session.id}:${base + index}`,
        at: 0,
        source: 'terminal',
        level: line.kind === 'stderr' ? 'error' : line.kind === 'command' ? 'info' : 'debug',
        title: line.text.slice(0, 300),
        origin: `${labels[session.environment] ?? session.environment} · ${session.name}`,
      });
    });
  }
  return events;
}

/** The agent's tool calls, as they were recorded while it worked. */
export function fromAgent(activities: AgentActivity[], at: number): TimelineEvent[] {
  return activities.map((activity, index) => ({
    id: `agent:${activity.id}`,
    at: at + index,
    source: 'agent',
    level: activity.state === 'error' ? 'error' : 'info',
    title: `${activity.tool}: ${activity.detail}`.slice(0, 300),
    origin: activity.state,
    detail: activity.result,
  }));
}

/**
 * Errors that are the same error.
 *
 * Grouped on the message with the parts that differ between occurrences
 * removed — numbers, quoted strings, hex ids — so twenty repetitions of one
 * fault read as one fault that happened twenty times.
 */
export function normaliseForGrouping(title: string): string {
  return title
    .replace(/0x[0-9a-f]+/gi, '0x…')
    .replace(/\b[0-9a-f]{8,}\b/gi, '…')
    .replace(/\b\d+\b/g, 'n')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '$1…$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface EventGroup {
  key: string;
  /** The first occurrence, which is the one worth reading. */
  first: TimelineEvent;
  count: number;
  /** The most recent occurrence's time, for ordering. */
  latest: number;
}

export function groupErrors(events: TimelineEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    if (event.level !== 'error') continue;
    const key = `${event.source}:${normaliseForGrouping(event.title)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.latest = Math.max(existing.latest, event.at);
    } else {
      groups.set(key, { key, first: event, count: 1, latest: event.at });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latest - a.latest);
}

export interface TimelineFilter {
  sources: Set<EventSource>;
  levels: Set<EventLevel>;
  query: string;
}

export function filterEvents(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  const query = filter.query.trim().toLowerCase();
  return events.filter((event) => {
    if (!filter.sources.has(event.source)) return false;
    if (!filter.levels.has(event.level)) return false;
    if (!query) return true;
    return (
      event.title.toLowerCase().includes(query) ||
      (event.origin ?? '').toLowerCase().includes(query) ||
      (event.detail ?? '').toLowerCase().includes(query)
    );
  });
}

/**
 * Merge and order.
 *
 * Newest first, because the question is nearly always "what just happened".
 * Terminal lines carry no timestamp, so they sort together at the end rather
 * than being given an invented one that would interleave them plausibly and
 * wrongly.
 */
export function mergeTimeline(...groups: TimelineEvent[][]): TimelineEvent[] {
  return groups.flat().sort((a, b) => b.at - a.at);
}

export const SOURCE_LABEL: Record<EventSource, string> = {
  preview: 'Preview runtime',
  build: 'Build',
  ide: 'TA CODE',
  terminal: 'Terminals',
  agent: 'AI agent',
  deploy: 'Deployments',
};

/**
 * What each source can and cannot tell us.
 *
 * The distinction that matters is between a source with nothing to report and
 * a source that is not connected at all. They render identically as an empty
 * list and mean opposite things, so the panel is told which is which.
 */
export function sourceAvailability(events: TimelineEvent[]): SourceAvailability[] {
  const counts = new Map<EventSource, number>();
  for (const event of events) counts.set(event.source, (counts.get(event.source) ?? 0) + 1);

  const sources: EventSource[] = ['preview', 'build', 'ide', 'terminal', 'agent', 'deploy'];
  return sources.map((source) => ({
    source,
    label: SOURCE_LABEL[source],
    available: source !== 'deploy',
    reason:
      source === 'deploy'
        ? 'No deployment target is configured, so there are no deployment events to collect.'
        : undefined,
    count: counts.get(source) ?? 0,
  }));
}

/**
 * The prompt that asks the agent to explain an incident.
 *
 * Built from events that were actually recorded, and nothing else. The agent is
 * asked to work from them rather than to speculate, because an incident summary
 * that invents a cause is worse than none — somebody acts on it.
 */
export function incidentPrompt(group: EventGroup, context: TimelineEvent[]): string {
  const lines = context
    .slice(0, 30)
    .map((event) => `[${event.source}${event.origin ? ` ${event.origin}` : ''}] ${event.title}`);

  return [
    `An error is recurring in this project. Explain what is happening and what to do about it.`,
    ``,
    `Error (seen ${group.count} time${group.count === 1 ? '' : 's'}), from ${SOURCE_LABEL[group.first.source]}:`,
    group.first.origin ? `  at ${group.first.origin}` : '',
    `  ${group.first.title}`,
    group.first.detail ? `\n${group.first.detail.slice(0, 2000)}` : '',
    ``,
    `Events recorded around it, newest first:`,
    ...lines.map((line) => `  ${line}`),
    ``,
    `Read the relevant files before answering. Base the explanation on these events and on what`,
    `the code actually does — if the recorded events are not enough to identify the cause, say so`,
    `and say what would be.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
