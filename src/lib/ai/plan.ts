import { isSensitivePath, normalizePath } from '@/lib/vfs';

/**
 * A plan the agent states before it changes anything.
 *
 * `plan_changes` exists so a person can disagree with an approach while
 * disagreeing is still cheap. That only works if the tool is **side-effect
 * free**: it writes no file, opens no panel, creates no directory, and touches
 * no store. It records an intention and returns it.
 *
 * This matters more than it sounds. A "planning" tool that quietly created the
 * files it planned would make the plan a fait accompli, and the review step
 * theatre. So the plan is data, the caller decides, and the ledger below exists
 * only so the UI can show what was proposed against what was actually done.
 */

export type PlannedOperation = 'create' | 'modify' | 'delete';

export interface PlannedChange {
  path: string;
  operation: PlannedOperation;
  /** Why, in the agent's own words. Bounded, because it goes on screen. */
  reason: string;
}

export interface ChangePlan {
  /** What the agent understands it was asked to do. */
  goal: string;
  changes: PlannedChange[];
  /** Steps that are not file changes: checks to run, things to verify. */
  steps: string[];
  at: number;
}

/** Files one plan may name, so a plan stays reviewable by a person. */
export const MAX_PLANNED_CHANGES = 40;
/** Non-file steps in one plan. */
export const MAX_PLAN_STEPS = 20;
/** Characters of any single reason or step. */
export const MAX_REASON_CHARS = 300;
/** Characters of the stated goal. */
export const MAX_GOAL_CHARS = 600;

const OPERATIONS: readonly PlannedOperation[] = ['create', 'modify', 'delete'];

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

function clip(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Read a plan out of whatever the model sent.
 *
 * Every path goes through the same choke point the write tools use, and an
 * absolute path is refused rather than reinterpreted — a plan naming
 * `/etc/passwd` is not a plan to be silently rewritten into a project path and
 * shown to a user as though the agent had proposed something reasonable.
 *
 * An operation the schema does not list is refused by name. Accepting it and
 * guessing `modify` would put a wrong verb in front of a user approving a plan.
 */
export function parsePlan(input: Record<string, unknown>, files: Record<string, string>): ChangePlan {
  const goalRaw = input.goal;
  if (typeof goalRaw !== 'string' || !goalRaw.trim()) {
    throw new PlanError('"goal" must be a non-empty string saying what you intend to achieve.');
  }

  const rawChanges = input.changes;
  if (!Array.isArray(rawChanges) || !rawChanges.length) {
    throw new PlanError('"changes" must be a non-empty array of {path, operation, reason}.');
  }
  if (rawChanges.length > MAX_PLANNED_CHANGES) {
    throw new PlanError(
      `A plan may name at most ${MAX_PLANNED_CHANGES} files; this one names ${rawChanges.length}. Split the work.`,
    );
  }

  const changes: PlannedChange[] = [];
  const seen = new Set<string>();

  for (const entry of rawChanges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PlanError('Each change must be an object with path, operation and reason.');
    }
    const record = entry as Record<string, unknown>;

    const rawPath = record.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new PlanError('Each change needs a "path".');
    }
    const candidate = rawPath.trim().replace(/\\/g, '/');
    if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) {
      throw new PlanError(
        `"${rawPath}" is an absolute path. Plan project-relative paths such as "src/app.ts".`,
      );
    }
    const path = normalizePath(candidate);
    if (isSensitivePath(path)) {
      throw new PlanError(`"${path}" is blocked by the workspace policy and cannot be planned.`);
    }
    if (seen.has(path)) {
      throw new PlanError(`"${path}" appears twice in the plan. Name each file once.`);
    }
    seen.add(path);

    const operation = record.operation;
    if (typeof operation !== 'string' || !OPERATIONS.includes(operation as PlannedOperation)) {
      throw new PlanError(
        `"operation" for ${path} must be one of: ${OPERATIONS.join(', ')}.`,
      );
    }

    /*
     * The plan is checked against what is actually there.
     *
     * A plan to "create" a file that exists is a plan to overwrite it, and a
     * user reading "create src/App.tsx" would not know their file was about to
     * be replaced. Naming the mismatch is the whole value of checking.
     */
    const exists = files[path] !== undefined;
    if (operation === 'create' && exists) {
      throw new PlanError(
        `${path} already exists, so this is a modification, not a creation. Plan it as "modify".`,
      );
    }
    if ((operation === 'modify' || operation === 'delete') && !exists) {
      throw new PlanError(
        `${path} does not exist, so it cannot be ${operation === 'delete' ? 'deleted' : 'modified'}. Plan it as "create" if you mean to add it.`,
      );
    }

    const reason = typeof record.reason === 'string' ? clip(record.reason, MAX_REASON_CHARS) : '';
    if (!reason) throw new PlanError(`Each change needs a "reason"; ${path} has none.`);

    changes.push({ path, operation: operation as PlannedOperation, reason });
  }

  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const steps = rawSteps
    .filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
    .slice(0, MAX_PLAN_STEPS)
    .map((step) => clip(step, MAX_REASON_CHARS));

  return { goal: clip(goalRaw, MAX_GOAL_CHARS), changes, steps, at: Date.now() };
}

/** The plan as the model should see it echoed back. */
export function renderPlan(plan: ChangePlan): string {
  const lines = [`Plan recorded (nothing has been changed yet).`, '', `Goal: ${plan.goal}`, ''];
  lines.push(`Files (${plan.changes.length}):`);
  for (const change of plan.changes) {
    lines.push(`  ${change.operation} ${change.path} — ${change.reason}`);
  }
  if (plan.steps.length) {
    lines.push('', 'Steps:');
    plan.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }
  lines.push(
    '',
    'This tool changed nothing. Carry the plan out with the write tools, and say so if you find it was wrong rather than improvising around it.',
  );
  return lines.join('\n');
}

/**
 * How a finished task compares with what was planned.
 *
 * Both directions are reported, and the second one is the one that matters: a
 * file changed that nobody planned is the thing a reviewer most needs to see.
 */
export function comparePlan(
  plan: ChangePlan,
  changedPaths: string[],
): { done: string[]; notDone: string[]; unplanned: string[] } {
  const planned = new Set(plan.changes.map((change) => change.path));
  const changed = new Set(changedPaths);
  return {
    done: [...planned].filter((path) => changed.has(path)),
    notDone: [...planned].filter((path) => !changed.has(path)),
    unplanned: [...changed].filter((path) => !planned.has(path)),
  };
}
