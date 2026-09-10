import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { usePresenceStore, type Participant } from '@/stores/presenceStore';

/**
 * Real presence, over Supabase Realtime.
 *
 * `presenceStore` was written as a seam: it has always reported only this tab
 * and said so through `transport`, rather than inventing colleagues. This fills
 * the seam with the transport the platform already provides — Realtime's own
 * presence, which is a CRDT maintained by the server, so two tabs joining at
 * once converge rather than racing.
 *
 * **It is not polling.** Nothing here fetches on an interval. The channel
 * pushes `sync`, `join` and `leave`, and this translates them. The only timer
 * is the heartbeat below, which republishes *this* tab's own state so an idle
 * participant does not appear frozen — and even that is a publish, not a fetch.
 *
 * **It reports absence rather than inventing presence.** With no Supabase
 * configured, or the channel not yet subscribed, `transport` stays
 * `local-only` and the UI keeps saying that only this tab is known. A presence
 * list that claims a colleague is online because the transport is broken is
 * worse than one that admits it cannot tell.
 *
 * **Authorisation is the database's, not this file's.** A channel name is not a
 * permission: anyone who can guess a project id could join the topic. What
 * stops that is that the topic carries no project content — only who is here
 * and which path they have open — and that membership is checked by RLS
 * everywhere the content actually lives. Presence must therefore never carry a
 * file's contents, and this module has no way to.
 */

/** How often this tab republishes its own state. */
const HEARTBEAT_MS = 30_000;

/** What one tab publishes about itself. Deliberately small and non-secret. */
interface PresencePayload {
  userId: string;
  displayName: string;
  email: string;
  activePath: string | null;
  at: number;
}

interface Connection {
  channel: RealtimeChannel;
  heartbeat: ReturnType<typeof setInterval>;
  projectId: string;
  /** Unsubscribes from the store, so the heartbeat sees the current self. */
  stopWatching: () => void;
}

let connection: Connection | null = null;

/**
 * Read one presence entry defensively.
 *
 * Everything here arrived from another client. A malformed or hostile payload
 * must produce no participant rather than a participant with rubbish in it —
 * this is rendered next to real people's names.
 */
function toParticipant(raw: unknown, selfUserId: string): Participant | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<PresencePayload>;
  const userId = typeof entry.userId === 'string' ? entry.userId.slice(0, 64) : '';
  if (!userId) return null;
  const email = typeof entry.email === 'string' ? entry.email.slice(0, 320) : '';
  const displayName =
    typeof entry.displayName === 'string' && entry.displayName.trim()
      ? entry.displayName.trim().slice(0, 80)
      : email || 'Someone';
  const activePath =
    typeof entry.activePath === 'string' && entry.activePath.length <= 1024
      ? entry.activePath
      : null;
  // A peer's clock is not this tab's. An `at` in the future would make a
  // participant permanently "online"; one absurdly old would hide them. Clamp
  // to now, which is the only clock this tab can trust.
  const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now();
  return {
    userId,
    displayName,
    email,
    activePath,
    lastSeenAt: Math.min(at, Date.now()),
    isSelf: userId === selfUserId,
  };
}

/**
 * Collapse Realtime's presence state into participants.
 *
 * One person may have several tabs open, which is several presence keys for one
 * `userId`. They are one participant — showing "Amina" three times in a
 * sidebar is noise, not information — so the most recent entry wins.
 */
function participantsFrom(state: Record<string, unknown[]>, selfUserId: string): Participant[] {
  const byUser = new Map<string, Participant>();
  for (const entries of Object.values(state)) {
    for (const raw of entries) {
      const participant = toParticipant(raw, selfUserId);
      if (!participant) continue;
      const existing = byUser.get(participant.userId);
      if (!existing || participant.lastSeenAt > existing.lastSeenAt) {
        byUser.set(participant.userId, participant);
      }
    }
  }
  return [...byUser.values()];
}

function payloadFromStore(): PresencePayload | null {
  const self = usePresenceStore.getState().self;
  if (!self) return null;
  return {
    userId: self.userId,
    displayName: self.displayName,
    email: self.email,
    activePath: self.activePath,
    at: Date.now(),
  };
}

/**
 * Join a project's presence channel.
 *
 * Idempotent for the same project, so a remount does not open a second channel.
 * Returns whether a transport was actually started — false with no Supabase, and
 * the store then correctly keeps saying it knows only this tab.
 */
export function connectPresence(
  client: SupabaseClient | null,
  projectId: string,
): boolean {
  if (!client || !projectId) return false;
  if (connection?.projectId === projectId) return true;
  disconnectPresence();

  const self = usePresenceStore.getState().self;
  if (!self) return false;
  const selfUserId = self.userId;

  const channel = client.channel(`presence:project:${projectId}`, {
    config: { presence: { key: `${selfUserId}:${Math.random().toString(36).slice(2, 10)}` } },
  });

  const publish = () => {
    const payload = payloadFromStore();
    if (payload) void channel.track(payload);
  };

  const apply = () => {
    const state = channel.presenceState() as unknown as Record<string, unknown[]>;
    usePresenceStore.getState().replaceRemote(participantsFrom(state, selfUserId));
  };

  channel
    .on('presence', { event: 'sync' }, apply)
    .on('presence', { event: 'join' }, apply)
    .on('presence', { event: 'leave' }, apply)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // Only now is anything actually known about anybody else.
        usePresenceStore.setState({ transport: 'realtime' });
        publish();
        return;
      }
      /*
       * Any other terminal status means this tab is not receiving presence.
       * Falling back to `local-only` is the honest reading: the list of
       * colleagues on screen would otherwise be whoever happened to be there
       * when the connection broke, frozen and presented as live.
       */
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        usePresenceStore.setState({ transport: 'local-only', remote: [] });
      }
    });

  // Republish when this tab's own file changes, so a colleague sees where it
  // moved to without waiting for the heartbeat.
  let lastPath = self.activePath;
  const stopWatching = usePresenceStore.subscribe((state) => {
    if (state.self && state.self.activePath !== lastPath) {
      lastPath = state.self.activePath;
      publish();
    }
  });

  connection = {
    channel,
    heartbeat: setInterval(publish, HEARTBEAT_MS),
    projectId,
    stopWatching,
  };
  return true;
}

/** Leave the channel and stop claiming to know about anyone else. */
export function disconnectPresence(): void {
  if (!connection) return;
  clearInterval(connection.heartbeat);
  connection.stopWatching();
  void connection.channel.unsubscribe();
  connection = null;
  usePresenceStore.setState({ transport: 'local-only', remote: [] });
}

/** Which project this tab is publishing presence for, if any. Exposed for tests. */
export function presenceProjectId(): string | null {
  return connection?.projectId ?? null;
}

export const __testing = { participantsFrom, toParticipant };
