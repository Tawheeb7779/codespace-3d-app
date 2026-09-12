/**
 * What the agent is allowed to claim it has verified.
 *
 * This module exists to stop one sentence being said untruthfully: *"I changed
 * it and the tests pass."* Every rule below closes a specific route by which
 * that sentence becomes false while each individual step looked reasonable.
 *
 * **A check is evidence about a state, not about a task.** It proves something
 * about the files as they were when it ran. Write to a file afterwards — the
 * agent's edit or the user's — and the proof is about a state that no longer
 * exists. So checks carry the revision they ran against, and a revision moves
 * on every write.
 *
 * **A failed check is cleared only by itself.** The most natural-looking
 * mistake an agent makes is: run the tests, they fail, edit something, run the
 * typecheck, it passes, report success. Two checks passed in that story and the
 * failing one was never re-run.
 *
 * **Repair is bounded.** An agent looping on a failure that has not changed is
 * not converging on a fix; it is spending the user's money to produce the same
 * error again.
 *
 * **Absent evidence is not good news.** With verification switched off the task
 * outcome is `unverified`. Not `completed` — that word claims evidence which
 * was never gathered, and it is the claim a person acts on.
 */

/** Repair attempts before the agent must stop and say what is wrong. */
export const MAX_REPAIR_ATTEMPTS = 3;

export interface CheckRecord {
  name: string;
  ok: boolean;
  detail: string;
  /** False when the check could not run here — which is not the same as failing. */
  ran: boolean;
  /** The workspace revision this ran against. */
  revision: number;
}

export interface ValidationState {
  /** Bumped by every write, so a check can be tied to the state it saw. */
  revision: number;
  /** Every check, in order. Stale ones are kept so they can be reported. */
  checks: CheckRecord[];
  repairAttempts: number;
  /** The last failure, normalised, so an unchanged one can be recognised. */
  lastFailure: string | null;
  /** Paths written since the last check, for an honest "what changed". */
  dirtiedBy: string[];
}

export function newValidation(): ValidationState {
  return { revision: 0, checks: [], repairAttempts: 0, lastFailure: null, dirtiedBy: [] };
}

/**
 * A write happened, so every check taken before it is now historical.
 *
 * The same function serves the agent's writes and the user's, because the
 * invalidation is identical: the files are not what the check looked at. Who
 * changed them is a reporting detail, not a correctness one.
 */
export function noteWrite(state: ValidationState, path: string): ValidationState {
  return {
    ...state,
    revision: state.revision + 1,
    dirtiedBy: state.dirtiedBy.includes(path) ? state.dirtiedBy : [...state.dirtiedBy, path],
  };
}

/** The user edited a file underneath the agent. Same invalidation, by design. */
export function noteUserEdit(state: ValidationState, path: string): ValidationState {
  return noteWrite(state, path);
}

export function recordCheck(
  state: ValidationState,
  check: { name: string; ok: boolean; detail: string; ran: boolean },
): ValidationState {
  return {
    ...state,
    checks: [...state.checks, { ...check, revision: state.revision }],
    // A check has just observed the current state, so nothing is outstanding
    // against it until the next write.
    dirtiedBy: [],
  };
}

/** Checks that ran against the files as they are now. */
export function currentChecks(state: ValidationState): CheckRecord[] {
  return state.checks.filter((check) => check.revision === state.revision);
}

/** Checks taken before a later write — real results about an older state. */
export function staleChecks(state: ValidationState): CheckRecord[] {
  return state.checks.filter((check) => check.revision !== state.revision);
}

/**
 * The latest outcome for each check name, current or not.
 *
 * Used to find a failure that has never been re-run: it is the newest record
 * under that name that decides, and if that record is stale the failure is
 * still outstanding.
 */
function latestByName(state: ValidationState): Map<string, CheckRecord> {
  const latest = new Map<string, CheckRecord>();
  for (const check of state.checks) latest.set(check.name, check);
  return latest;
}

/**
 * Checks that failed and have not since passed under their own name.
 *
 * This is the rule that stops a typecheck clearing a failing test suite.
 */
export function outstandingFailures(state: ValidationState): CheckRecord[] {
  return [...latestByName(state).values()].filter((check) => check.ran && !check.ok);
}

/**
 * Is the current state of the files backed by evidence?
 *
 * Three things must hold: something ran, everything that ran most recently
 * under its own name passed, and at least one passing check is *current* rather
 * than describing an older state.
 */
export function isVerified(state: ValidationState): boolean {
  const ran = state.checks.filter((check) => check.ran);
  if (!ran.length) return false;
  if (outstandingFailures(state).length) return false;
  return currentChecks(state).some((check) => check.ran && check.ok);
}

/**
 * Reduce a failure to what makes it that failure.
 *
 * Timings, absolute paths and whitespace vary run to run; treating a rerun as a
 * *different* failure because it took 3.8s instead of 1.2s would defeat the
 * unchanged-failure stop entirely.
 */
export function failureSignature(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\(\s*\d+(?:\.\d+)?\s*m?s\s*\)/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, ' ')
    .replace(/\/[^\s:]+\//g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RepairDecision {
  allowed: boolean;
  /** Why not, in words a user can read. Empty when allowed. */
  reason: string;
  next: ValidationState;
}

/**
 * May the agent try to fix this failure again?
 *
 * Two separate stops, and they answer different questions. The attempt count
 * bounds total effort. The unchanged-failure check answers "is this working at
 * all" — an identical failure after an edit means the edit did not touch the
 * cause, and three more of those will not either.
 */
export function repairDecision(state: ValidationState, failure: string): RepairDecision {
  const signature = failureSignature(failure);

  if (state.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
    return {
      allowed: false,
      reason: `Stopped after ${MAX_REPAIR_ATTEMPTS} attempts to fix this. The failure is still there, and continuing would be guessing.`,
      next: state,
    };
  }

  if (state.lastFailure !== null && state.lastFailure === signature) {
    return {
      allowed: false,
      reason:
        'The failure is unchanged since the last attempt, so the edit did not reach the cause. Stopping rather than trying the same thing again.',
      next: state,
    };
  }

  return {
    allowed: true,
    reason: '',
    next: { ...state, repairAttempts: state.repairAttempts + 1, lastFailure: signature },
  };
}

/**
 * How a task ended, in the only three words that are honest about evidence.
 *
 * `unverified` is the important one. It is what a task gets when it changed
 * files and nothing current backs them — because verification was off, because
 * a check was never run, or because an edit landed after the last check. All
 * three mean the same thing to a person deciding whether to trust the change.
 */
export type TaskOutcome = 'completed' | 'unverified' | 'failed';

export function outcomeFor(input: {
  state: ValidationState;
  verificationEnabled: boolean;
  changedFiles: number;
}): TaskOutcome {
  const { state, verificationEnabled, changedFiles } = input;

  // A real failure is a failure whether or not verification was configured on:
  // the check ran, and it said no.
  if (outstandingFailures(state).length) return 'failed';

  // Nothing was changed, so there is nothing to have verified.
  if (changedFiles === 0) return 'completed';

  // Off means no evidence was gathered. That is not the same as fine.
  if (!verificationEnabled) return 'unverified';

  return isVerified(state) ? 'completed' : 'unverified';
}

/** What to tell the user about the evidence, in one or two sentences. */
export function summariseValidation(state: ValidationState): string {
  const failures = outstandingFailures(state);
  if (failures.length) {
    const names = failures.map((check) => check.name).join(', ');
    return `Still failing: ${names}. ${failures[0].detail}`;
  }

  const ran = state.checks.filter((check) => check.ran);
  if (!ran.length) return 'Nothing was checked, so nothing here is known to work.';

  const current = currentChecks(state).filter((check) => check.ran);
  if (!current.length) {
    const changed = state.dirtiedBy.length
      ? ` ${state.dirtiedBy.slice(0, 5).join(', ')} changed since.`
      : '';
    return `The last checks passed, but the files have changed since — that result is out of date.${changed}`;
  }

  const names = current.map((check) => check.name).join(', ');
  return `${current.length} check${current.length === 1 ? '' : 's'} passed against the current files: ${names}.`;
}
