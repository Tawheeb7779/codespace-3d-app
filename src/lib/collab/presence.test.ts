import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { usePresenceStore } from '@/stores/presenceStore';
import {
  __testing,
  connectPresence,
  disconnectPresence,
  presenceProjectId,
} from '@/lib/collab/presenceTransport';

/**
 * Real presence, and the honesty it has to keep.
 *
 * The store has always distinguished "nobody else is here" from "I cannot tell
 * who is here", and `transport` is that distinction. A transport that leaves
 * `realtime` set after the channel drops turns the second into the first: the
 * colleagues frozen on screen read as live, and someone acts on a stale answer
 * to "is anyone else editing this?".
 *
 * The other property is that presence carries no project content — only who is
 * present and which path they have open. The channel topic is a guessable
 * string, so anything on it is effectively public to anyone who can guess a
 * project id; membership is enforced by the database, where the content is.
 */

const { participantsFrom, toParticipant } = __testing;

interface FakeChannel {
  handlers: Record<string, () => void>;
  tracked: unknown[];
  state: Record<string, unknown[]>;
  subscribeCallback: ((status: string) => void) | null;
  unsubscribed: boolean;
}

let channel: FakeChannel;

/** A Supabase client whose channel this test drives by hand. */
function fakeClient(): SupabaseClient {
  channel = {
    handlers: {},
    tracked: [],
    state: {},
    subscribeCallback: null,
    unsubscribed: false,
  };
  const api = {
    on(_type: string, filter: { event: string }, handler: () => void) {
      channel.handlers[filter.event] = handler;
      return api;
    },
    subscribe(callback: (status: string) => void) {
      channel.subscribeCallback = callback;
      return api;
    },
    track(payload: unknown) {
      channel.tracked.push(payload);
      return Promise.resolve('ok');
    },
    presenceState: () => channel.state,
    unsubscribe: () => {
      channel.unsubscribed = true;
      return Promise.resolve('ok');
    },
  };
  return { channel: () => api } as unknown as SupabaseClient;
}

const AMINA = {
  id: 'user-amina',
  email: 'amina@example.test',
  displayName: 'Amina',
} as never;

beforeEach(() => {
  disconnectPresence();
  usePresenceStore.setState({ projectId: null, self: null, remote: [], transport: 'local-only' });
  vi.useRealTimers();
});

describe('connecting', () => {
  it('does not claim a transport when Supabase is not configured', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);

    expect(connectPresence(null, 'proj-1')).toBe(false);
    expect(usePresenceStore.getState().transport).toBe('local-only');
  });

  it('does not claim a transport before the channel has subscribed', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);

    connectPresence(fakeClient(), 'proj-1');

    // The channel exists; nothing is known about anybody yet.
    expect(usePresenceStore.getState().transport).toBe('local-only');
  });

  it('reports realtime and publishes this tab once subscribed', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    connectPresence(fakeClient(), 'proj-1');

    channel.subscribeCallback!('SUBSCRIBED');

    expect(usePresenceStore.getState().transport).toBe('realtime');
    expect(channel.tracked).toHaveLength(1);
  });

  /**
   * The frozen-list failure. If the channel drops and `transport` stays
   * `realtime`, whoever was listed at that moment stays on screen as though
   * they were still there.
   */
  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    'stops claiming to know anyone after %s',
    (status) => {
      usePresenceStore.getState().enter('proj-1', AMINA);
      connectPresence(fakeClient(), 'proj-1');
      channel.subscribeCallback!('SUBSCRIBED');
      channel.state = { k1: [{ userId: 'user-bilal', displayName: 'Bilal', email: '', at: Date.now() }] };
      channel.handlers.sync();
      expect(usePresenceStore.getState().remote).toHaveLength(1);

      channel.subscribeCallback!(status);

      expect(usePresenceStore.getState().transport).toBe('local-only');
      expect(usePresenceStore.getState().remote).toEqual([]);
    },
  );

  it('does not open a second channel for the same project', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    const client = fakeClient();
    const spy = vi.spyOn(client, 'channel');

    connectPresence(client, 'proj-1');
    connectPresence(client, 'proj-1');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves the room on disconnect', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    connectPresence(fakeClient(), 'proj-1');
    channel.subscribeCallback!('SUBSCRIBED');

    disconnectPresence();

    expect(channel.unsubscribed).toBe(true);
    expect(presenceProjectId()).toBeNull();
    expect(usePresenceStore.getState().transport).toBe('local-only');
  });
});

describe('reading what other tabs published', () => {
  it('collapses several tabs of one person into one participant', () => {
    const now = Date.now();
    const state = {
      a: [{ userId: 'user-bilal', displayName: 'Bilal', email: 'b@x.test', activePath: 'a.ts', at: now - 5000 }],
      b: [{ userId: 'user-bilal', displayName: 'Bilal', email: 'b@x.test', activePath: 'b.ts', at: now }],
    };

    const people = participantsFrom(state, 'user-amina');

    expect(people).toHaveLength(1);
    // The most recent tab wins, so the file shown is where they actually are.
    expect(people[0].activePath).toBe('b.ts');
  });

  it('marks this tab’s own entry as self so it is not listed twice', () => {
    const state = { a: [{ userId: 'user-amina', displayName: 'Amina', email: '', at: Date.now() }] };

    expect(participantsFrom(state, 'user-amina')[0].isSelf).toBe(true);
  });

  /** Everything here came from another client and is therefore hostile input. */
  it.each([null, 'a string', 42, {}, { userId: '' }, { userId: 123 }])(
    'produces no participant from the malformed entry %j',
    (raw) => {
      expect(toParticipant(raw, 'user-amina')).toBeNull();
    },
  );

  it('bounds an over-long name rather than rendering it beside real people', () => {
    const person = toParticipant(
      { userId: 'u1', displayName: 'x'.repeat(5000), email: 'e'.repeat(5000), at: Date.now() },
      'me',
    );

    expect(person!.displayName.length).toBeLessThanOrEqual(80);
    expect(person!.email.length).toBeLessThanOrEqual(320);
  });

  /**
   * A peer's clock is not this one's. An `at` in the future would keep a
   * participant permanently "online" however long ago they actually left.
   */
  it('never trusts a peer’s clock past now', () => {
    const person = toParticipant(
      { userId: 'u1', displayName: 'A', email: '', at: Date.now() + 86_400_000 },
      'me',
    );

    expect(person!.lastSeenAt).toBeLessThanOrEqual(Date.now());
  });

  it('drops an over-long path instead of carrying it', () => {
    const person = toParticipant(
      { userId: 'u1', displayName: 'A', email: '', activePath: 'x'.repeat(2000), at: Date.now() },
      'me',
    );

    expect(person!.activePath).toBeNull();
  });
});

describe('what presence publishes', () => {
  /**
   * The topic is a guessable string. Anything published on it is readable by
   * anyone who can guess a project id, so it must carry no file content —
   * which is why the payload is a path and never a body.
   */
  it('publishes only identity and a path, never file content', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    usePresenceStore.getState().touch('src/secret.ts');
    connectPresence(fakeClient(), 'proj-1');
    channel.subscribeCallback!('SUBSCRIBED');

    const payload = channel.tracked[0] as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'activePath',
      'at',
      'displayName',
      'email',
      'userId',
    ]);
    expect(payload.activePath).toBe('src/secret.ts');
  });

  it('republishes when this tab moves to another file', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    connectPresence(fakeClient(), 'proj-1');
    channel.subscribeCallback!('SUBSCRIBED');
    const before = channel.tracked.length;

    usePresenceStore.getState().touch('src/app.ts');

    expect(channel.tracked.length).toBeGreaterThan(before);
  });
});

describe('entering a project twice', () => {
  /**
   * The bug this guards: `enter` used to clear `remote`, so a second caller
   * mounting after the channel had synced wiped the colleague list.
   */
  it('does not clear the colleagues the transport already found', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    usePresenceStore.getState().replaceRemote([
      { userId: 'user-bilal', displayName: 'Bilal', email: '', activePath: null, lastSeenAt: Date.now(), isSelf: false },
    ]);

    usePresenceStore.getState().enter('proj-1', AMINA);

    expect(usePresenceStore.getState().remote).toHaveLength(1);
  });

  it('does clear them when the project actually changes', () => {
    usePresenceStore.getState().enter('proj-1', AMINA);
    usePresenceStore.getState().replaceRemote([
      { userId: 'user-bilal', displayName: 'Bilal', email: '', activePath: null, lastSeenAt: Date.now(), isSelf: false },
    ]);

    usePresenceStore.getState().enter('proj-2', AMINA);

    expect(usePresenceStore.getState().remote).toEqual([]);
  });
});
