import { describe, expect, it } from 'vitest';
import {
  filterEvents,
  fromAgent,
  fromBuild,
  fromConsole,
  fromTerminals,
  groupErrors,
  incidentPrompt,
  mergeTimeline,
  normaliseForGrouping,
  sourceAvailability,
  type EventLevel,
  type EventSource,
  type TimelineEvent,
} from '@/lib/observability/timeline';
import { ENVIRONMENT_LABEL, type TerminalSession } from '@/stores/terminalStore';

/**
 * One timeline, and the two ways it could mislead.
 *
 * The first is blurring sources. A failure in the Linux Terminal says nothing
 * about the project; a log line from the sandboxed preview is the running
 * application talking, not the IDE. Merging them without saying which is which
 * invites a conclusion drawn from the wrong machine, so every event carries its
 * source and the terminal events carry their environment.
 *
 * The second is presenting an unconfigured source as a quiet one. Both render
 * as an empty list and they mean opposite things: "nothing went wrong" versus
 * "nothing is watching".
 */

const event = (over: Partial<TimelineEvent> & { id: string }): TimelineEvent => ({
  at: 1_000,
  source: 'ide',
  level: 'info',
  title: 'something',
  ...over,
});

describe('reading the console buffer', () => {
  it('separates the running app from the bundler from the IDE', () => {
    const events = fromConsole([
      { id: '1', level: 'error', channel: 'preview', message: 'app blew up', timestamp: 1 },
      { id: '2', level: 'info', channel: 'build', message: 'bundled', timestamp: 2 },
      { id: '3', level: 'info', channel: 'ide', message: 'saved', timestamp: 3 },
    ]);

    expect(events.map((entry) => entry.source)).toEqual(['preview', 'build', 'ide']);
  });

  it('keeps the first line as the title and the rest as detail', () => {
    const events = fromConsole([
      { id: '1', level: 'error', channel: 'preview', message: 'boom\n  at thing()', timestamp: 1 },
    ]);

    expect(events[0].title).toBe('boom');
    expect(events[0].detail).toContain('at thing()');
  });

  it('carries no detail when there is nothing more than the title', () => {
    const events = fromConsole([
      { id: '1', level: 'log', channel: 'ide', message: 'one line', timestamp: 1 },
    ]);

    expect(events[0].detail).toBeUndefined();
  });
});

describe('reading the build', () => {
  const signal = {
    status: 'error',
    entry: 'src/main.tsx',
    lastBuildMs: 120,
    errors: [{ path: 'src/a.ts', line: 3, column: 5, message: 'Unexpected token' }],
    warnings: [],
    buildToken: 7,
  };

  it('reports each diagnostic with the place it points at', () => {
    const events = fromBuild(signal, 1_000);

    const diagnostic = events.find((entry) => entry.title === 'Unexpected token');
    expect(diagnostic?.origin).toBe('src/a.ts:3:5');
    expect(diagnostic?.level).toBe('error');
  });

  it('reports a failed build as a failure, with the count', () => {
    const events = fromBuild(signal, 1_000);

    expect(events.some((entry) => /Build failed with 1 error/.test(entry.title))).toBe(true);
  });

  it('reports a successful build with the time it took', () => {
    const events = fromBuild({ ...signal, status: 'running', errors: [] }, 1_000);

    expect(events.some((entry) => /Build succeeded in 120ms/.test(entry.title))).toBe(true);
  });

  /** An idle preview has not built anything; there is nothing to report. */
  it('reports nothing when nothing has been built', () => {
    expect(fromBuild({ ...signal, status: 'idle' }, 1_000)).toEqual([]);
  });
});

describe('reading the terminals', () => {
  const session = (over: Partial<TerminalSession>): TerminalSession =>
    ({
      id: 't1',
      name: 'project',
      environment: 'project',
      cwd: '',
      history: [],
      lines: [],
      busy: false,
      revision: 0,
      ...over,
    }) as TerminalSession;

  /** The whole reason the two-terminal architecture exists. */
  it('says which environment each line came from', () => {
    const events = fromTerminals(
      [
        session({ id: 'a', environment: 'project', lines: [{ kind: 'stdout', text: 'in project' }] }),
        session({ id: 'b', environment: 'linux', name: 'linux', lines: [{ kind: 'stdout', text: 'in linux' }] }),
      ],
      ENVIRONMENT_LABEL,
    );

    const project = events.find((entry) => entry.title === 'in project');
    const linux = events.find((entry) => entry.title === 'in linux');
    expect(project?.origin).toContain(ENVIRONMENT_LABEL.project);
    expect(linux?.origin).toContain(ENVIRONMENT_LABEL.linux);
    expect(project?.origin).not.toBe(linux?.origin);
  });

  it('reads stderr as an error and a command as information', () => {
    const events = fromTerminals(
      [
        session({
          lines: [
            { kind: 'command', text: 'npm test' },
            { kind: 'stderr', text: 'failed' },
          ],
        }),
      ],
      ENVIRONMENT_LABEL,
    );

    expect(events.find((entry) => entry.title === 'npm test')?.level).toBe('info');
    expect(events.find((entry) => entry.title === 'failed')?.level).toBe('error');
  });

  it('takes only the recent tail, so scrollback cannot flood the timeline', () => {
    const lines = Array.from({ length: 500 }, (_, index) => ({
      kind: 'stdout' as const,
      text: `line ${index}`,
    }));

    const events = fromTerminals([session({ lines })], ENVIRONMENT_LABEL, 40);

    expect(events).toHaveLength(40);
    expect(events[events.length - 1].title).toBe('line 499');
  });

  it('skips blank lines rather than filling the timeline with them', () => {
    const events = fromTerminals(
      [session({ lines: [{ kind: 'stdout', text: '   ' }, { kind: 'stdout', text: 'real' }] })],
      ENVIRONMENT_LABEL,
    );

    expect(events).toHaveLength(1);
  });
});

describe('reading the agent', () => {
  it('reports a failed tool call as an error', () => {
    const events = fromAgent(
      [{ id: 'a1', tool: 'write_file', detail: 'src/a.ts', state: 'error', result: 'refused' }],
      1_000,
    );

    expect(events[0].level).toBe('error');
    expect(events[0].detail).toBe('refused');
  });

  it('reports a completed tool call as information', () => {
    const events = fromAgent([{ id: 'a1', tool: 'read_file', detail: 'src/a.ts', state: 'done' }], 1);

    expect(events[0].level).toBe('info');
  });
});

describe('grouping the same error together', () => {
  it('collapses occurrences that differ only in their numbers', () => {
    const events = [
      event({ id: '1', level: 'error', source: 'preview', title: 'Cannot read property x of undefined at line 12' }),
      event({ id: '2', level: 'error', source: 'preview', title: 'Cannot read property x of undefined at line 48' }),
    ];

    const groups = groupErrors(events);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  /** Two machines failing the same way is two problems, not one. */
  it('keeps the same message from different sources apart', () => {
    const groups = groupErrors([
      event({ id: '1', level: 'error', source: 'preview', title: 'ENOENT' }),
      event({ id: '2', level: 'error', source: 'terminal', title: 'ENOENT' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('ignores everything that is not an error', () => {
    expect(groupErrors([event({ id: '1', level: 'warn', title: 'careful' })])).toEqual([]);
  });

  it('puts the most frequent first', () => {
    const groups = groupErrors([
      event({ id: '1', level: 'error', title: 'rare' }),
      event({ id: '2', level: 'error', title: 'common n' }),
      event({ id: '3', level: 'error', title: 'common n' }),
    ]);

    expect(groups[0].count).toBe(2);
  });

  it.each([
    ['at 0xdeadbeef', 'at 0x…'],
    ['id 9f2a1b3c4d5e', 'id …'],
    ['line 42', 'line n'],
    ['cannot find "thing"', 'cannot find "…"'],
  ])('normalises %j', (input, expected) => {
    expect(normaliseForGrouping(input)).toBe(expected);
  });
});

describe('filtering', () => {
  const events = [
    event({ id: '1', source: 'preview', level: 'error', title: 'app failed' }),
    event({ id: '2', source: 'terminal', level: 'info', title: 'npm test', origin: 'Linux Terminal' }),
  ];
  const all = {
    sources: new Set<EventSource>(['preview', 'terminal']),
    levels: new Set<EventLevel>(['error', 'info']),
    query: '',
  };

  it('narrows to the chosen sources', () => {
    const shown = filterEvents(events, { ...all, sources: new Set<EventSource>(['preview']) });

    expect(shown.map((entry) => entry.id)).toEqual(['1']);
  });

  it('narrows to the chosen levels', () => {
    const shown = filterEvents(events, { ...all, levels: new Set<EventLevel>(['error']) });

    expect(shown.map((entry) => entry.id)).toEqual(['1']);
  });

  it('searches the origin as well as the title', () => {
    expect(filterEvents(events, { ...all, query: 'linux' }).map((entry) => entry.id)).toEqual(['2']);
  });

  it('is case-insensitive', () => {
    expect(filterEvents(events, { ...all, query: 'APP FAILED' })).toHaveLength(1);
  });
});

describe('ordering', () => {
  it('puts the newest first, because the question is what just happened', () => {
    const merged = mergeTimeline(
      [event({ id: 'old', at: 100 })],
      [event({ id: 'new', at: 900 })],
    );

    expect(merged.map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  /**
   * Terminal lines carry no timestamp. Giving them one would let them
   * interleave plausibly and wrongly with events that do.
   */
  it('does not invent a time for an event that has none', () => {
    const merged = mergeTimeline(
      [event({ id: 'timed', at: 500 })],
      [event({ id: 'untimed', at: 0 })],
    );

    expect(merged.map((entry) => entry.id)).toEqual(['timed', 'untimed']);
  });
});

describe('what each source can tell us', () => {
  /** An unconfigured source and a quiet one look identical and are not. */
  it('reports deployments as unavailable rather than as quiet', () => {
    const deploy = sourceAvailability([]).find((entry) => entry.source === 'deploy');

    expect(deploy?.available).toBe(false);
    expect(deploy?.reason).toMatch(/no deployment target/i);
  });

  it('reports a connected source with nothing to say as available and empty', () => {
    const preview = sourceAvailability([]).find((entry) => entry.source === 'preview');

    expect(preview?.available).toBe(true);
    expect(preview?.count).toBe(0);
  });

  it('counts what each source actually contributed', () => {
    const availability = sourceAvailability([
      event({ id: '1', source: 'preview' }),
      event({ id: '2', source: 'preview' }),
      event({ id: '3', source: 'build' }),
    ]);

    expect(availability.find((entry) => entry.source === 'preview')?.count).toBe(2);
    expect(availability.find((entry) => entry.source === 'build')?.count).toBe(1);
  });
});

describe('asking the agent about an incident', () => {
  it('carries the recorded events and nothing invented', () => {
    const events = [
      event({ id: '1', level: 'error', source: 'preview', title: 'boom', origin: 'app.ts:1' }),
      event({ id: '2', source: 'terminal', title: 'npm run dev', origin: 'Project Terminal' }),
    ];
    const prompt = incidentPrompt(groupErrors(events)[0], events);

    expect(prompt).toContain('boom');
    expect(prompt).toContain('app.ts:1');
    expect(prompt).toContain('npm run dev');
  });

  /** An incident summary that invents a cause is one somebody acts on. */
  it('tells the agent to say when the events are not enough', () => {
    const events = [event({ id: '1', level: 'error', title: 'boom' })];
    const prompt = incidentPrompt(groupErrors(events)[0], events);

    expect(prompt).toMatch(/not enough to identify the cause, say so/i);
  });

  it('says how many times it happened', () => {
    const events = [
      event({ id: '1', level: 'error', title: 'boom n' }),
      event({ id: '2', level: 'error', title: 'boom n' }),
    ];
    const prompt = incidentPrompt(groupErrors(events)[0], events);

    expect(prompt).toContain('seen 2 times');
  });
});
