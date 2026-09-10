import { create } from 'zustand';
import type { AuthUser } from '@/types';

/**
 * Who is present in a project.
 *
 * This is the foundation for collaboration, not collaboration itself. Forge
 * has no realtime transport yet, so the only participant this store can
 * honestly report is the person using this tab. It says exactly that rather
 * than inventing colleagues, and `transport` is what the UI reads to decide
 * whether to claim anything about other people at all.
 *
 * The shape is the part that matters: when a transport does arrive it feeds
 * `replaceRemote`, and every consumer keeps working unchanged. Nothing else in
 * the app needs to learn about presence twice.
 */

export type PresenceTransport = 'local-only' | 'realtime';

export interface Participant {
  userId: string;
  displayName: string;
  email: string;
  /** The file this participant has open, when they have shared one. */
  activePath: string | null;
  /** Epoch millis of their last observed activity. */
  lastSeenAt: number;
  /** True for the person using this tab. */
  isSelf: boolean;
}

/** Beyond this, a participant is shown as away rather than online. */
export const IDLE_AFTER_MS = 2 * 60_000;

export type PresenceStatus = 'online' | 'away' | 'offline';

export function statusFor(participant: Participant, now = Date.now()): PresenceStatus {
  const elapsed = now - participant.lastSeenAt;
  if (elapsed < IDLE_AFTER_MS) return 'online';
  if (elapsed < IDLE_AFTER_MS * 5) return 'away';
  return 'offline';
}

interface PresenceState {
  projectId: string | null;
  /** Only ever this tab's participant until a transport exists. */
  self: Participant | null;
  /** Populated by a realtime transport. Empty by design today. */
  remote: Participant[];
  transport: PresenceTransport;

  enter: (projectId: string, user: AuthUser) => void;
  touch: (activePath: string | null) => void;
  leave: () => void;
  /** Entry point for a future transport; nothing calls it yet. */
  replaceRemote: (participants: Participant[]) => void;
  participants: () => Participant[];
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  projectId: null,
  self: null,
  remote: [],
  // Honest by default. A transport flips this when one is actually connected.
  transport: 'local-only',

  /**
   * Announce this tab in a project.
   *
   * Idempotent for the same project and person, and that matters now that a
   * transport exists: re-entering used to clear `remote`, so any second caller
   * — a panel mounting after the channel had synced — wiped the list of
   * colleagues until the next presence event. Re-entering the *same* room is
   * not arriving in it again.
   */
  enter(projectId, user) {
    const current = get().self;
    if (get().projectId === projectId && current?.userId === user.id) {
      set({ self: { ...current, lastSeenAt: Date.now() } });
      return;
    }
    set({
      projectId,
      self: {
        userId: user.id,
        displayName: user.displayName || user.email,
        email: user.email,
        activePath: null,
        lastSeenAt: Date.now(),
        isSelf: true,
      },
      // A different project is a different room: whoever was in the last one
      // is not in this one, and carrying them over would be a false claim.
      remote: [],
    });
  },

  touch(activePath) {
    const self = get().self;
    if (!self) return;
    // Avoid a write per keystroke: only a changed file or a real elapsed
    // interval is worth a state update.
    const now = Date.now();
    if (self.activePath === activePath && now - self.lastSeenAt < 15_000) return;
    set({ self: { ...self, activePath, lastSeenAt: now } });
  },

  leave: () => set({ projectId: null, self: null, remote: [] }),

  replaceRemote: (participants) =>
    set({ remote: participants.filter((participant) => !participant.isSelf) }),

  participants: () => {
    const { self, remote } = get();
    return self ? [self, ...remote] : remote;
  },
}));
