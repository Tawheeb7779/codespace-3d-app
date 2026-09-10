import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { channelNameFor, openDocumentSession, type DocumentSession } from '@/lib/collab/yTransport';
import { colourFor, useCollabStore } from '@/stores/collabStore';

/**
 * Editing the same file together, and the two ways that goes wrong.
 *
 * The first is divergence — two people type at once and end up with different
 * files. That is Yjs's problem, and using a CRDT rather than a homemade merge
 * is the answer; the tests below check the integration really is a CRDT by
 * driving two documents through this transport and comparing them.
 *
 * The second is duplication at bootstrap, which is subtler and looks exactly
 * like corruption. A joiner that seeds an empty shared document from its own
 * copy of the file will, if a peer already holds that file, produce a document
 * containing every line twice. So a joiner asks first and seeds only when
 * nobody answers — and the tests hold that line in both directions.
 */

/**
 * A room of fake Realtime channels.
 *
 * Broadcast is delivered to every other member synchronously, which is enough
 * to exercise the protocol; ordering and latency are Yjs's concern and are the
 * thing it is designed to survive.
 */
interface Room {
  client: () => SupabaseClient;
}

function createRoom(): Room {
  let members: Array<{ deliver: (payload: unknown) => void }> = [];

  const client = (): SupabaseClient =>
    ({
      channel(_name: string) {
        const member: { deliver: (payload: unknown) => void } = { deliver: () => undefined };
        let handler: ((message: { payload?: unknown }) => void) | null = null;
        const api = {
          on(_type: string, _filter: unknown, next: (message: { payload?: unknown }) => void) {
            handler = next;
            return api;
          },
          subscribe(callback: (status: string) => void) {
            member.deliver = (payload) => handler?.({ payload });
            members.push(member);
            callback('SUBSCRIBED');
            return api;
          },
          send({ payload }: { payload: unknown }) {
            for (const other of members) {
              if (other !== member) other.deliver(payload);
            }
            return Promise.resolve('ok');
          },
          unsubscribe() {
            members = members.filter((entry) => entry !== member);
            return Promise.resolve('ok');
          },
        };
        return api;
      },
    }) as unknown as SupabaseClient;

  return { client };
}

const identity = (name: string) => ({ userId: name, displayName: name, colour: '#e8833a' });

function join(
  room: Room,
  who: string,
  initialText: string,
  onStatus = vi.fn(),
): DocumentSession {
  return openDocumentSession({
    client: room.client(),
    projectId: 'proj-1',
    path: 'src/app.ts',
    identity: identity(who),
    initialText: () => initialText,
    onStatus,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useCollabStore.setState({ enabled: false, status: 'offline', detail: null, path: null, peers: [] });
});

describe('the first person to open a file', () => {
  it('seeds the document from their own copy once nobody answers', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'const x = 1;\n');

    vi.advanceTimersByTime(2000);

    expect(amina.text.toString()).toBe('const x = 1;\n');
    amina.destroy();
  });

  it('reports connected only after that has been settled', () => {
    const room = createRoom();
    const onStatus = vi.fn();
    const amina = join(room, 'amina', 'hello', onStatus);

    expect(amina.status()).toBe('bootstrapping');
    vi.advanceTimersByTime(2000);

    expect(amina.status()).toBe('connected');
    expect(onStatus).toHaveBeenCalledWith('connected', undefined);
    amina.destroy();
  });
});

describe('somebody joining a file that is already open', () => {
  /**
   * The duplication bug, stated as a test. Both tabs hold the same file on
   * disk; if the joiner seeds too, the document ends up with it twice.
   */
  it('takes the peer’s document rather than seeding its own copy', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'const x = 1;\n');
    vi.advanceTimersByTime(2000);

    const bilal = join(room, 'bilal', 'const x = 1;\n');
    vi.advanceTimersByTime(2000);

    expect(bilal.text.toString()).toBe('const x = 1;\n');
    expect(amina.text.toString()).toBe('const x = 1;\n');
    amina.destroy();
    bilal.destroy();
  });

  it('stops waiting as soon as a peer answers', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'seeded');
    vi.advanceTimersByTime(2000);

    const bilal = join(room, 'bilal', 'a different local copy');

    // Answered synchronously by the room, so no timer had to expire.
    expect(bilal.status()).toBe('connected');
    expect(bilal.text.toString()).toBe('seeded');
    amina.destroy();
    bilal.destroy();
  });

  /**
   * A joiner whose local file differs — because they had it open before the
   * peer changed it — must not push their copy over the shared one.
   */
  it('never applies its own copy over a document a peer already holds', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'the shared version');
    vi.advanceTimersByTime(2000);

    const bilal = join(room, 'bilal', 'a stale local version');
    vi.advanceTimersByTime(2000);

    expect(bilal.text.toString()).toBe('the shared version');
    expect(bilal.text.toString()).not.toContain('stale');
    amina.destroy();
    bilal.destroy();
  });
});

describe('two people typing at once', () => {
  it('converges on one document rather than diverging', () => {
    const room = createRoom();
    const amina = join(room, 'amina', '');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);

    amina.doc.transact(() => amina.text.insert(0, 'function a() {}\n'));
    bilal.doc.transact(() => bilal.text.insert(0, 'function b() {}\n'));
    vi.advanceTimersByTime(100);

    // A CRDT guarantees they agree; which order they agree on is its choice.
    expect(amina.text.toString()).toBe(bilal.text.toString());
    expect(amina.text.toString()).toContain('function a()');
    expect(amina.text.toString()).toContain('function b()');
    amina.destroy();
    bilal.destroy();
  });

  it('keeps both edits when they land in the same place', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'AZ');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);

    amina.doc.transact(() => amina.text.insert(1, 'B'));
    bilal.doc.transact(() => bilal.text.insert(1, 'C'));
    vi.advanceTimersByTime(100);

    expect(amina.text.toString()).toBe(bilal.text.toString());
    expect(amina.text.toString()).toContain('B');
    expect(amina.text.toString()).toContain('C');
    expect(amina.text.toString()).toHaveLength(4);
    amina.destroy();
    bilal.destroy();
  });

  it('does not echo a remote edit back around the room', () => {
    const room = createRoom();
    const amina = join(room, 'amina', '');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);

    amina.doc.transact(() => amina.text.insert(0, 'x'));
    vi.advanceTimersByTime(500);

    // An echo would apply the same insert repeatedly.
    expect(bilal.text.toString()).toBe('x');
    expect(amina.text.toString()).toBe('x');
    amina.destroy();
    bilal.destroy();
  });
});

describe('who is in the room', () => {
  it('tells each peer about the other', () => {
    const room = createRoom();
    const amina = join(room, 'amina', '');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);

    const seenByAmina = [...amina.awareness.getStates().keys()];
    expect(seenByAmina).toContain(bilal.doc.clientID);
    amina.destroy();
    bilal.destroy();
  });

  /** A caret left behind is a person who appears to still be there. */
  it('removes a caret when its tab leaves', () => {
    const room = createRoom();
    const amina = join(room, 'amina', '');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);
    const bilalId = bilal.doc.clientID;

    bilal.destroy();
    vi.advanceTimersByTime(100);

    expect([...amina.awareness.getStates().keys()]).not.toContain(bilalId);
    amina.destroy();
  });
});

describe('a channel that is not working', () => {
  it('says edits are local only rather than looking like collaboration', () => {
    const onStatus = vi.fn();
    const failing = {
      channel: () => {
        const api = {
          on: () => api,
          subscribe: (callback: (status: string) => void) => {
            callback('CHANNEL_ERROR');
            return api;
          },
          send: () => Promise.resolve('ok'),
          unsubscribe: () => Promise.resolve('ok'),
        };
        return api;
      },
    } as unknown as SupabaseClient;

    const session = openDocumentSession({
      client: failing,
      projectId: 'proj-1',
      path: 'a.ts',
      identity: identity('amina'),
      initialText: () => 'x',
      onStatus,
    });

    expect(session.status()).toBe('error');
    expect(onStatus).toHaveBeenCalledWith('error', expect.stringMatching(/local only/i));
    session.destroy();
  });

  /** A malformed payload from a peer must not take the editor down. */
  it('survives rubbish arriving on the channel', () => {
    const room = createRoom();
    const amina = join(room, 'amina', 'safe');
    vi.advanceTimersByTime(2000);
    const bilal = join(room, 'bilal', '');
    vi.advanceTimersByTime(2000);

    const channel = (bilal as unknown as { doc: Y.Doc }).doc;
    expect(() => {
      // Reaching the handler the way a hostile peer would: through the room.
      const client = room.client();
      const evil = client.channel('x') as unknown as {
        on: (t: string, f: unknown, h: (m: { payload?: unknown }) => void) => unknown;
        subscribe: (cb: (s: string) => void) => unknown;
        send: (m: { payload: unknown }) => unknown;
      };
      evil.on('broadcast', {}, () => undefined);
      evil.subscribe(() => undefined);
      evil.send({ payload: { k: 'update', v: 'not base64 at all !!!' } });
      evil.send({ payload: { k: 'awareness', v: '@@@@' } });
      evil.send({ payload: 'a string, not an object' });
      evil.send({ payload: null });
    }).not.toThrow();

    expect(channel).toBeDefined();
    expect(amina.text.toString()).toBe('safe');
    amina.destroy();
    bilal.destroy();
  });
});

describe('naming a channel', () => {
  it('gives the same file the same room on every peer', () => {
    expect(channelNameFor('p1', 'src/app.ts')).toBe(channelNameFor('p1', 'src/app.ts'));
  });

  it('gives different files different rooms', () => {
    expect(channelNameFor('p1', 'src/a.ts')).not.toBe(channelNameFor('p1', 'src/b.ts'));
  });

  it('keeps projects apart', () => {
    expect(channelNameFor('p1', 'src/a.ts')).not.toBe(channelNameFor('p2', 'src/a.ts'));
  });

  it('produces a legal topic from a path that is not', () => {
    const name = channelNameFor('p1', 'src/a file with spaces & #hash.ts');

    expect(name).toMatch(/^[A-Za-z0-9:_-]+$/);
  });
});

describe('the collaboration switch', () => {
  it('is off until somebody turns it on', () => {
    expect(useCollabStore.getState().enabled).toBe(false);
  });

  /** Turning it off must end the claim, not only the connection. */
  it('stops claiming a session when turned off', () => {
    useCollabStore.setState({ enabled: true, status: 'connected', path: 'a.ts', peers: [] });

    useCollabStore.getState().setEnabled(false);

    expect(useCollabStore.getState().status).toBe('offline');
    expect(useCollabStore.getState().path).toBeNull();
  });

  it('gives one person the same colour every time', () => {
    expect(colourFor('user-amina')).toBe(colourFor('user-amina'));
    expect(colourFor('user-amina')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
