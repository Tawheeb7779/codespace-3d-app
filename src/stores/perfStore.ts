import { create } from 'zustand';
import type { BuildSample } from '@/lib/perf/metrics';

/**
 * What each build actually cost, kept so builds can be compared.
 *
 * The preview store holds the *current* build; a profiler needs the previous
 * one to say whether anything changed. This records a sample per build, newest
 * first, from numbers the bundler really produced.
 *
 * **Not persisted, deliberately.** A build time from a previous session was
 * measured on a machine in a different state, against code that has changed
 * since, and comparing today's build against it would produce a trend that
 * means nothing. A session's samples are comparable with each other; that is
 * the honest window.
 */

interface PerfState {
  samples: BuildSample[];
  record: (sample: Omit<BuildSample, 'at'>) => void;
  clear: () => void;
}

/** Enough to see a trend; not so many that the panel becomes a log. */
const MAX_SAMPLES = 30;

export const usePerfStore = create<PerfState>()((set) => ({
  samples: [],

  record: (sample) =>
    set((state) => ({
      samples: [{ ...sample, at: Date.now() }, ...state.samples].slice(0, MAX_SAMPLES),
    })),

  clear: () => set({ samples: [] }),
}));
