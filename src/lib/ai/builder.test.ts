import { describe, expect, it } from 'vitest';
import { buildPrompt, hasPlan, parsePlan, planPrompt, summarise } from '@/lib/ai/builder';

/**
 * Building from a description, and the two claims that must not slip.
 *
 * The first turn must not change anything. It exists so a person can disagree
 * with the approach before files move, and a builder that starts editing on the
 * first message cannot be stopped in time — so the instruction is checked here
 * rather than trusted to stay in the prompt.
 *
 * And the summary must come from what the agent recorded, never from the plan.
 * A step that was planned and not carried out appearing as done is the exact
 * fabrication the whole panel exists not to produce — as is "built" standing in
 * for "verified" when no check was ever run.
 */

describe('asking for a plan', () => {
  /** The instruction the first turn depends on. */
  it('tells the agent to change nothing in this turn', () => {
    const prompt = planPrompt('add a settings page', true);

    expect(prompt).toMatch(/Do NOT create, edit or delete any file in this turn/);
    expect(prompt).toMatch(/Do not run any command/);
  });

  it('carries what was asked for', () => {
    expect(planPrompt('add a settings page', true)).toContain('add a settings page');
  });

  it('asks for a parseable form rather than prose', () => {
    expect(planPrompt('x', true)).toContain('PLAN:');
  });

  /**
   * Without this the agent plans to run tests it cannot run, and then reports
   * having run them.
   */
  it('says when there is no container to run checks in', () => {
    const withContainer = planPrompt('x', true);
    const without = planPrompt('x', false);

    expect(withContainer).toMatch(/container workspace is attached/i);
    expect(without).toMatch(/not be able to run this project’s tests/i);
    expect(without).toMatch(/rather than assuming you can/i);
  });
});

describe('reading the plan back', () => {
  it('takes the numbered steps', () => {
    const steps = parsePlan('Some preamble.\nPLAN: Read the router\nPLAN: Add the page\nDone.');

    expect(steps).toEqual([
      { index: 1, text: 'Read the router' },
      { index: 2, text: 'Add the page' },
    ]);
  });

  it('tolerates a bullet or a number in front', () => {
    const steps = parsePlan('- PLAN: 1. Do the thing');

    expect(steps[0].text).toBe('Do the thing');
  });

  it('is case-insensitive about the marker', () => {
    expect(parsePlan('plan: lowercase')).toHaveLength(1);
  });

  /**
   * A plan inferred from prose would be a plan nobody wrote, shown for approval
   * as though somebody had.
   */
  it('finds no plan in an answer that contains none', () => {
    const reply = 'I would probably start by looking at the router, then add a page.';

    expect(parsePlan(reply)).toEqual([]);
    expect(hasPlan(reply)).toBe(false);
  });

  it('ignores an empty step', () => {
    expect(parsePlan('PLAN:   \nPLAN: real')).toHaveLength(1);
  });

  it('bounds how long a plan can be', () => {
    const many = Array.from({ length: 100 }, (_, index) => `PLAN: step ${index}`).join('\n');

    expect(parsePlan(many).length).toBeLessThanOrEqual(40);
  });

  it('bounds how long one step can be', () => {
    const steps = parsePlan(`PLAN: ${'x'.repeat(1000)}`);

    expect(steps[0].text.length).toBeLessThanOrEqual(300);
  });
});

describe('asking for the build', () => {
  it('carries the approved plan, numbered as it was shown', () => {
    const prompt = buildPrompt('goal', [
      { index: 1, text: 'first' },
      { index: 2, text: 'second' },
    ], true);

    expect(prompt).toContain('1. first');
    expect(prompt).toContain('2. second');
  });

  it('tells the agent to stop rather than improvise if the plan was wrong', () => {
    expect(buildPrompt('goal', [], true)).toMatch(
      /say so and stop rather than\s+improvising something I did not agree to/i,
    );
  });

  /** The instruction that stops "I ran the tests" when there were none to run. */
  it('forbids claiming a test run with no container', () => {
    expect(buildPrompt('goal', [], false)).toMatch(/Do not claim you did/i);
  });

  it('asks it to fix a failure rather than describe it', () => {
    expect(buildPrompt('goal', [], true)).toMatch(/fix it rather than describing it/i);
  });
});

describe('the summary', () => {
  it('counts the files that were really changed', () => {
    const text = summarise({
      changed: [{ path: 'a.ts', kind: 'edited' }, { path: 'b.ts', kind: 'created' }],
      verified: [{ name: 'test', ok: true, detail: 'exit 0' }],
    });

    expect(text).toContain('2 files changed');
  });

  it('says plainly when nothing was changed', () => {
    expect(summarise({ changed: [], verified: [] })).toContain('No files were changed');
  });

  /**
   * The distinction the panel turns on: written is not working, and a summary
   * that blurs them is how somebody ships an unverified change believing it was
   * checked.
   */
  it('says nothing is known to work when no check was run', () => {
    const text = summarise({ changed: [{ path: 'a.ts', kind: 'edited' }], verified: [] });

    expect(text).toMatch(/Nothing was verified/i);
    expect(text).toMatch(/nothing here is known to work/i);
  });

  it('names the checks that failed', () => {
    const text = summarise({
      changed: [],
      verified: [
        { name: 'test', ok: false, detail: 'exit 1' },
        { name: 'lint', ok: true, detail: 'exit 0' },
      ],
    });

    expect(text).toContain('1 of 2 checks failed');
    expect(text).toContain('test');
  });

  it('reports a clean run as passing', () => {
    const text = summarise({ changed: [], verified: [{ name: 'test', ok: true, detail: 'exit 0' }] });

    expect(text).toContain('1 check passed');
  });
});
