import { describe, expect, it } from 'vitest';
import {
  MAX_REPAIR_ATTEMPTS,
  currentChecks,
  failureSignature,
  isVerified,
  newValidation,
  noteUserEdit,
  noteWrite,
  outcomeFor,
  recordCheck,
  repairDecision,
  staleChecks,
  summariseValidation,
} from '@/lib/ai/validation';

/**
 * What "verified" is allowed to mean.
 *
 * The whole module exists to stop one sentence being said untruthfully: "I
 * changed it and the tests pass." Each rule below closes a specific way that
 * sentence becomes false while every individual step looked reasonable.
 *
 *   * A check proves something about the files it ran against. Edit a file
 *     afterwards and the proof is about a state that no longer exists.
 *   * A check that failed is not cleared by a *different* check passing. That
 *     is the most natural-looking mistake an agent makes: run tests, they fail,
 *     fix, run the typecheck, it passes, report success.
 *   * Repair is bounded. An agent looping on an unchanged failure is not
 *     converging; it is burning the user's money and their patience.
 *   * With verification turned off there is no evidence at all, so the outcome
 *     is `unverified` — never `completed`, which claims evidence that was never
 *     gathered.
 */

const passing = { name: 'test', ok: true, detail: 'exit 0', ran: true };
const failing = { name: 'test', ok: false, detail: 'exit 1: 2 failed', ran: true };

describe('a check is tied to the state it ran against', () => {
  it('counts as current when nothing has changed since', () => {
    const state = recordCheck(newValidation(), passing);

    expect(currentChecks(state)).toHaveLength(1);
    expect(staleChecks(state)).toHaveLength(0);
    expect(isVerified(state)).toBe(true);
  });

  /** The agent's own edit invalidates its own evidence. */
  it('goes stale when the agent writes a file afterwards', () => {
    const state = noteWrite(recordCheck(newValidation(), passing), 'src/a.ts');

    expect(currentChecks(state)).toHaveLength(0);
    expect(staleChecks(state)).toHaveLength(1);
    expect(isVerified(state)).toBe(false);
  });

  /** And so does the user's, which the agent never sees coming. */
  it('goes stale when the user edits a file afterwards', () => {
    const state = noteUserEdit(recordCheck(newValidation(), passing), 'src/a.ts');

    expect(isVerified(state)).toBe(false);
    expect(staleChecks(state)[0].name).toBe('test');
  });

  it('becomes current again when the same check is re-run', () => {
    let state = recordCheck(newValidation(), passing);
    state = noteWrite(state, 'src/a.ts');
    state = recordCheck(state, passing);

    expect(isVerified(state)).toBe(true);
    expect(currentChecks(state)).toHaveLength(1);
  });

  it('records which revision each check ran against', () => {
    let state = recordCheck(newValidation(), passing);
    const first = state.checks[0].revision;
    state = recordCheck(noteWrite(state, 'src/a.ts'), passing);

    expect(state.checks[1].revision).toBeGreaterThan(first);
  });
});

describe('a failed check needs its own re-run', () => {
  /** The mistake this exists to prevent, stated as a test. */
  it('is not cleared by a different check passing', () => {
    let state = recordCheck(newValidation(), failing);
    state = noteWrite(state, 'src/a.ts');
    state = recordCheck(state, { name: 'typecheck', ok: true, detail: 'exit 0', ran: true });

    expect(isVerified(state)).toBe(false);
    expect(summariseValidation(state)).toMatch(/test/);
  });

  it('is cleared only when that same check passes again', () => {
    let state = recordCheck(newValidation(), failing);
    state = noteWrite(state, 'src/a.ts');
    state = recordCheck(state, passing);

    expect(isVerified(state)).toBe(true);
  });

  it('stays unverified while the same check keeps failing', () => {
    let state = recordCheck(newValidation(), failing);
    state = recordCheck(noteWrite(state, 'src/a.ts'), failing);

    expect(isVerified(state)).toBe(false);
  });

  /** A check that could not run is not a check that passed. */
  it('does not count a check that could not run as evidence', () => {
    const state = recordCheck(newValidation(), {
      name: 'test',
      ok: false,
      detail: 'no container',
      ran: false,
    });

    expect(isVerified(state)).toBe(false);
  });

  it('is not verified when nothing has been checked at all', () => {
    expect(isVerified(newValidation())).toBe(false);
  });
});

describe('bounded repair', () => {
  it('allows the first attempt', () => {
    const decision = repairDecision(newValidation(), 'exit 1: 2 failed');

    expect(decision.allowed).toBe(true);
  });

  it(`stops after ${MAX_REPAIR_ATTEMPTS} attempts`, () => {
    let state = newValidation();
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const decision = repairDecision(state, `failure ${attempt}`);
      expect(decision.allowed).toBe(true);
      state = decision.next;
    }
    const final = repairDecision(state, 'failure again');

    expect(final.allowed).toBe(false);
    expect(final.reason).toMatch(/3 attempts/i);
  });

  /**
   * An identical failure twice means the last edit changed nothing that
   * mattered. Continuing is not converging.
   */
  it('stops early when the failure has not changed', () => {
    const first = repairDecision(newValidation(), 'exit 1: 2 failed');
    const second = repairDecision(first.next, 'exit 1: 2 failed');

    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/unchanged/i);
  });

  it('continues while the failure is genuinely different', () => {
    const first = repairDecision(newValidation(), 'exit 1: 2 failed');
    const second = repairDecision(first.next, 'exit 1: 1 failed');

    expect(second.allowed).toBe(true);
  });

  it('counts attempts, so the caller can show how many are left', () => {
    const first = repairDecision(newValidation(), 'a');

    expect(first.next.repairAttempts).toBe(1);
  });

  /** Whitespace and run-to-run timings must not read as a different failure. */
  it('normalises a failure before comparing it', () => {
    const first = repairDecision(newValidation(), 'exit 1:   2 failed  (1.2s)');
    const second = repairDecision(first.next, 'exit 1: 2 failed (3.8s)');

    expect(second.allowed).toBe(false);
  });
});

describe('the failure signature', () => {
  it('is stable across timings and whitespace', () => {
    expect(failureSignature('FAIL a.test.ts (1.23s)')).toBe(failureSignature('FAIL a.test.ts  (9.9s)'));
  });

  it('distinguishes genuinely different failures', () => {
    expect(failureSignature('2 failed')).not.toBe(failureSignature('1 failed'));
  });
});

describe('what a finished task may claim', () => {
  it('is completed when the checks that ran are current and passing', () => {
    const state = recordCheck(newValidation(), passing);

    expect(outcomeFor({ state, verificationEnabled: true, changedFiles: 1 })).toBe('completed');
  });

  it('is failed when a current check failed', () => {
    const state = recordCheck(newValidation(), failing);

    expect(outcomeFor({ state, verificationEnabled: true, changedFiles: 1 })).toBe('failed');
  });

  /**
   * The claim this forbids: "completed" with no evidence, because verification
   * was switched off. Off means unverified, not fine.
   */
  it('is unverified — never completed — when verification is disabled', () => {
    const state = newValidation();

    expect(outcomeFor({ state, verificationEnabled: false, changedFiles: 3 })).toBe('unverified');
  });

  it('is unverified even if a stale check passed before the edits', () => {
    const state = noteWrite(recordCheck(newValidation(), passing), 'src/a.ts');

    expect(outcomeFor({ state, verificationEnabled: true, changedFiles: 1 })).toBe('unverified');
  });

  it('is unverified when files changed and nothing was checked', () => {
    expect(
      outcomeFor({ state: newValidation(), verificationEnabled: true, changedFiles: 2 }),
    ).toBe('unverified');
  });

  /** Nothing changed and nothing needed checking is a real completion. */
  it('is completed when nothing was changed at all', () => {
    expect(
      outcomeFor({ state: newValidation(), verificationEnabled: true, changedFiles: 0 }),
    ).toBe('completed');
  });

  it('never reports completed when verification is off, whatever else is true', () => {
    const state = recordCheck(newValidation(), passing);

    expect(outcomeFor({ state, verificationEnabled: false, changedFiles: 1 })).not.toBe('completed');
  });
});

describe('what the user is told', () => {
  it('names the check that is still failing', () => {
    const state = recordCheck(newValidation(), failing);

    expect(summariseValidation(state)).toContain('test');
    expect(summariseValidation(state)).toMatch(/failing/i);
  });

  it('says plainly when the evidence is out of date', () => {
    const state = noteWrite(recordCheck(newValidation(), passing), 'src/a.ts');

    expect(summariseValidation(state)).toMatch(/changed since|out of date|no longer/i);
  });

  it('says nothing was checked when nothing was', () => {
    expect(summariseValidation(newValidation())).toMatch(/nothing was checked/i);
  });

  it('reports a clean, current pass', () => {
    expect(summariseValidation(recordCheck(newValidation(), passing))).toMatch(/passed/i);
  });
});
