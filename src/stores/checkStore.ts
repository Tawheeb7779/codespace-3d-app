import { create } from 'zustand';

/**
 * The last time each project check was run, and what it said.
 *
 * The checks panel held its result in component state, which meant the answer
 * to "do the tests pass?" disappeared when the panel closed. That is fine for a
 * panel and useless for a health dashboard, which needs to distinguish three
 * states that a single boolean cannot: passing, failing, and *not run*.
 *
 * Nothing here runs anything. Both callers — the panel a person clicks and the
 * agent's `run_project_check` — already run checks through the gateway's
 * five-name allowlist; this only remembers what came back, so a dashboard can
 * report a real exit code rather than an assumption.
 *
 * **It is deliberately not persisted.** A stored "tests passed" from a previous
 * session would be read as current, and the code has changed since. A result
 * belongs to the session that produced it.
 */

export interface CheckOutcome {
  script: string;
  ok: boolean;
  exitCode: number;
  /** Trimmed: the dashboard wants the verdict, the panel keeps the full log. */
  summary: string;
  at: number;
}

interface CheckState {
  results: Record<string, CheckOutcome>;
  record: (outcome: Omit<CheckOutcome, 'at'>) => void;
  clear: () => void;
  /** The most recent result for a script, or null when it has not been run. */
  latest: (script: string) => CheckOutcome | null;
  /** Every result, newest first. */
  all: () => CheckOutcome[];
}

/** Enough of the output to recognise the failure, not the whole log. */
const SUMMARY_LIMIT = 400;

export const useCheckStore = create<CheckState>()((set, get) => ({
  results: {},

  record: (outcome) =>
    set((state) => ({
      results: {
        ...state.results,
        [outcome.script]: {
          ...outcome,
          summary: outcome.summary.trim().slice(-SUMMARY_LIMIT),
          at: Date.now(),
        },
      },
    })),

  clear: () => set({ results: {} }),

  latest: (script) => get().results[script] ?? null,

  all: () => Object.values(get().results).sort((a, b) => b.at - a.at),
}));
