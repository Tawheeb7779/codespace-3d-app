/**
 * Building something from a description, through the agent that already exists.
 *
 * This is not a second AI system. It is two prepared prompts and a small piece
 * of state between them: the first asks the agent to read the project and write
 * a plan, the second asks it to carry that plan out. Both go through
 * `aiStore.send`, so the tools, the approval prompts for destructive changes,
 * the change ledger and the verification records are the ones the assistant
 * panel has always used. A separate builder with its own execution path would
 * be a second set of rules, and the rules are the security model.
 *
 * **The plan is shown before anything is written.** That is the whole shape of
 * it: describe, read, plan, *review*, then build. A builder that starts editing
 * on the first message is one somebody cannot stop in time.
 *
 * **Nothing here reports progress it did not observe.** The steps a person sees
 * afterwards are the agent's own recorded activities and verifications — the
 * files it really changed and the checks it really ran — not a script of what a
 * build is supposed to involve.
 */

export type BuilderPhase =
  /** Nothing asked yet. */
  | 'idle'
  /** The agent is reading the project and writing a plan. */
  | 'planning'
  /** A plan is on screen, waiting for a person. */
  | 'review'
  /** The agent is carrying the plan out. */
  | 'building'
  /** It finished. What it did is on screen. */
  | 'done';

export interface PlanStep {
  /** 1-based, as the plan numbered it. */
  index: number;
  text: string;
}

/**
 * Ask for a plan, and for no changes yet.
 *
 * The instruction not to write anything is repeated because it is the part that
 * matters: this turn exists so a person can disagree with the approach before
 * files move.
 */
export function planPrompt(request: string, hasContainer: boolean): string {
  return [
    'I want you to build something in this project. Before changing anything, read the project and',
    'write a plan.',
    '',
    `What I want: ${request.trim()}`,
    '',
    'Do this now:',
    '  1. Read the files you need to understand what is already here.',
    '  2. Write a numbered plan of the changes you would make, one line each, in the form:',
    '     PLAN: <the step>',
    '  3. Say what could go wrong, and anything you need me to decide.',
    '',
    'Do NOT create, edit or delete any file in this turn. Do not run any command. This turn is for',
    'reading and planning only — I want to see the approach before anything moves.',
    hasContainer
      ? 'A container workspace is attached, so you will be able to run this project’s real checks when you build.'
      : 'No container workspace is attached, so you will not be able to run this project’s tests. Say so in the plan rather than assuming you can.',
  ].join('\n');
}

/** Carry out the plan that was reviewed, and verify it. */
export function buildPrompt(request: string, steps: PlanStep[], hasContainer: boolean): string {
  return [
    'Carry out the plan you wrote. This is the approved version:',
    '',
    ...steps.map((step) => `  ${step.index}. ${step.text}`),
    '',
    `The goal, again: ${request.trim()}`,
    '',
    'While you work:',
    '  • Make the changes, one file at a time, reading before writing.',
    '  • Ask before anything destructive — I will be asked to approve it.',
    hasContainer
      ? '  • Run the project’s checks when you are done and read what they say.'
      : '  • There is no container workspace, so you cannot run this project’s tests. Do not claim you did.',
    '  • If something fails, read the failure and fix it rather than describing it.',
    '  • Finish with a short summary of what you changed and what you verified.',
    '',
    'If you find the plan was wrong once you are inside the code, say so and stop rather than',
    'improvising something I did not agree to.',
  ].join('\n');
}

/**
 * Read the plan back out of the reply.
 *
 * The agent is asked for `PLAN:` lines, and those are taken. Nothing is
 * inferred from prose: a plan invented from an answer that contained none would
 * be a plan nobody wrote, shown for approval as though somebody had.
 */
export function parsePlan(reply: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of reply.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?PLAN:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const text = match[1].replace(/^\d+[.)]\s*/, '').trim();
    if (text) steps.push({ index: steps.length + 1, text: text.slice(0, 300) });
  }
  return steps.slice(0, 40);
}

/** Whether a reply contains a usable plan at all. */
export function hasPlan(reply: string): boolean {
  return parsePlan(reply).length > 0;
}

export interface BuildOutcome {
  /** Files the agent actually changed, from its own ledger. */
  changed: Array<{ path: string; kind: string }>;
  /** Checks it actually ran, from its own verification records. */
  verified: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * What to tell somebody at the end.
 *
 * Built from the agent's records rather than from the plan: a step that was
 * planned and not carried out must not appear as done, which is what listing
 * the plan as a summary would do.
 */
export function summarise(outcome: BuildOutcome): string {
  const parts: string[] = [];

  if (outcome.changed.length) {
    parts.push(
      `${outcome.changed.length} file${outcome.changed.length === 1 ? '' : 's'} changed.`,
    );
  } else {
    parts.push('No files were changed.');
  }

  if (!outcome.verified.length) {
    // The distinction the whole panel turns on.
    parts.push('Nothing was verified — no check was run, so nothing here is known to work.');
  } else {
    const failed = outcome.verified.filter((entry) => !entry.ok);
    parts.push(
      failed.length
        ? `${failed.length} of ${outcome.verified.length} checks failed: ${failed.map((entry) => entry.name).join(', ')}.`
        : `${outcome.verified.length} check${outcome.verified.length === 1 ? '' : 's'} passed.`,
    );
  }

  return parts.join(' ');
}
