import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CollabStatus } from '@/lib/collab/yTransport';

/**
 * Whether this tab is editing together with anyone, and how that is going.
 *
 * Off by default, and deliberately so. Shared editing changes what a keystroke
 * means — it leaves the machine — and turning that on without being asked is
 * not a default anybody chose. The switch is per person and remembered; the
 * *status* is per file and is never remembered, because a status restored from
 * storage would claim a connection that does not exist yet.
 *
 * `status` is the honest half. `connected` appears only once the document is
 * genuinely synchronised with whoever else holds it; until then it is
 * `bootstrapping`, and if the channel fails it is `error` with the reason —
 * never a quiet fall back to local editing that looks identical to working
 * collaboration.
 */

/**
 * Colours for remote cursors.
 *
 * Chosen for separation from each other rather than from the palette: these
 * label *people*, and two collaborators whose carets look alike is the one
 * thing this must not do. Deliberately not accent/positive/caution/danger —
 * a cursor is not a status, and borrowing a status colour would make one
 * person's caret read as an error.
 */
const CURSOR_COLOURS = [
  '#e8833a',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#eab308',
  '#3b82f6',
] as const;

/** A stable colour per person, so somebody keeps their colour across sessions. */
export function colourFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return CURSOR_COLOURS[hash % CURSOR_COLOURS.length];
}

export interface CollabPeer {
  /** Yjs client id, which is per tab rather than per person. */
  clientId: number;
  userId: string;
  displayName: string;
  colour: string;
}

interface CollabState {
  /** The person's choice. Remembered. */
  enabled: boolean;
  /** The live state of the open file's document. Never remembered. */
  status: CollabStatus;
  /** Why, when the status is `error`. */
  detail: string | null;
  /** The file the current session is for, so a stale status is never shown. */
  path: string | null;
  /** Everyone else editing this file right now. */
  peers: CollabPeer[];

  setEnabled: (enabled: boolean) => void;
  beginSession: (path: string) => void;
  setStatus: (status: CollabStatus, detail?: string) => void;
  setPeers: (peers: CollabPeer[]) => void;
  endSession: () => void;
}

export const useCollabStore = create<CollabState>()(
  persist(
    (set) => ({
      enabled: false,
      status: 'offline',
      detail: null,
      path: null,
      peers: [],

      setEnabled: (enabled) =>
        set(
          enabled
            ? { enabled }
            : // Turning it off ends the claim as well as the connection.
              { enabled, status: 'offline', detail: null, path: null, peers: [] },
        ),

      beginSession: (path) => set({ path, status: 'bootstrapping', detail: null, peers: [] }),

      setStatus: (status, detail) => set({ status, detail: detail ?? null }),

      setPeers: (peers) => set({ peers }),

      endSession: () => set({ status: 'offline', detail: null, path: null, peers: [] }),
    }),
    {
      name: 'ta-code-collab',
      // Only the preference. A persisted `connected` would show a synchronised
      // document on a page that has not connected to anything.
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);
