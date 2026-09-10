import { create } from 'zustand';
import { uid } from '@/lib/utils';
import {
  captureSnapshot,
  trimHistory,
  type Snapshot,
  type SnapshotReason,
} from '@/lib/timetravel/history';

/**
 * The project as it was, at moments that mattered.
 *
 * Snapshots are taken at a handful of points — before the agent changes files,
 * on a build, on a commit, or when somebody asks — never on a keystroke. A copy
 * of the project per keystroke is how a recorder becomes the reason the editor
 * is slow, and the caps in `history.ts` are what keep this bounded.
 *
 * **Not persisted.** A snapshot is a copy of somebody's source; writing it to
 * browser storage would leave the project's contents sitting in `localStorage`
 * after they closed the tab, which is a copy nobody asked for. The history
 * belongs to the session that made it.
 */

interface TimeTravelState {
  snapshots: Snapshot[];
  /** True while a restore is being applied, so the UI cannot start a second. */
  restoring: boolean;

  capture: (files: Record<string, string>, reason: SnapshotReason, label: string) => string | null;
  remove: (id: string) => void;
  clear: () => void;
  setRestoring: (restoring: boolean) => void;
  find: (id: string) => Snapshot | null;
}

/**
 * How close together two snapshots for the same reason may be.
 *
 * Builds can fire in quick succession while somebody types; without this the
 * history fills with near-identical copies and the older, more useful points
 * are pushed out.
 */
const MIN_GAP_MS = 5_000;

export const useTimeTravelStore = create<TimeTravelState>()((set, get) => ({
  snapshots: [],
  restoring: false,

  capture(files, reason, label) {
    const latest = get().snapshots[0];
    if (latest && latest.reason === reason && Date.now() - latest.at < MIN_GAP_MS) return null;
    // An empty project has nothing worth a point on the timeline.
    if (!Object.keys(files).length) return null;

    const id = uid('snap');
    const snapshot = captureSnapshot(files, reason, label, id, Date.now());
    set((state) => ({ snapshots: trimHistory([snapshot, ...state.snapshots]) }));
    return id;
  },

  remove: (id) =>
    set((state) => ({ snapshots: state.snapshots.filter((snapshot) => snapshot.id !== id) })),

  clear: () => set({ snapshots: [] }),

  setRestoring: (restoring) => set({ restoring }),

  find: (id) => get().snapshots.find((snapshot) => snapshot.id === id) ?? null,
}));
