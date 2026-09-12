import { describe, expect, it } from 'vitest';
import {
  MAX_PLANNED_CHANGES,
  MAX_REASON_CHARS,
  comparePlan,
  parsePlan,
  renderPlan,
} from '@/lib/ai/plan';

/**
 * Stating a plan before carrying it out, and the property the whole thing rests
 * on: **planning changes nothing.**
 *
 * A review step exists so disagreeing is cheap. A "planning" tool that created
 * the files it planned would make the plan a fait accompli and the review
 * theatre — so this module is pure, and the test below proves it by handing it
 * a file map and checking the map is untouched.
 *
 * The second property is that a plan is checked against reality. "create
 * src/App.tsx" for a file that already exists is a plan to overwrite somebody's
 * work, and a user approving it would not know that from the word "create".
 */

const FILES = {
  'src/App.tsx': 'export const App = () => null;\n',
  'src/lib/helper.ts': 'export const helper = 1;\n',
};

const change = (overrides: Record<string, unknown> = {}) => ({
  path: 'src/App.tsx',
  operation: 'modify',
  reason: 'add the settings route',
  ...overrides,
});

describe('a valid plan', () => {
  it('is parsed with its goal, changes and steps', () => {
    const plan = parsePlan(
      { goal: 'Add a settings page', changes: [change()], steps: ['run the build'] },
      FILES,
    );

    expect(plan.goal).toBe('Add a settings page');
    expect(plan.changes).toEqual([
      { path: 'src/App.tsx', operation: 'modify', reason: 'add the settings route' },
    ]);
    expect(plan.steps).toEqual(['run the build']);
  });

  it('accepts creating a file that does not exist', () => {
    const plan = parsePlan(
      { goal: 'g', changes: [change({ path: 'src/New.tsx', operation: 'create' })] },
      FILES,
    );

    expect(plan.changes[0].operation).toBe('create');
  });

  it('normalises the paths it was given', () => {
    const plan = parsePlan({ goal: 'g', changes: [change({ path: './src/App.tsx' })] }, FILES);

    expect(plan.changes[0].path).toBe('src/App.tsx');
  });

  it('works with no steps', () => {
    expect(parsePlan({ goal: 'g', changes: [change()] }, FILES).steps).toEqual([]);
  });
});

describe('planning changes nothing', () => {
  /** The property the review step depends on. */
  it('leaves the file map exactly as it was', () => {
    const files = { ...FILES };
    const before = JSON.stringify(files);

    parsePlan(
      {
        goal: 'g',
        changes: [change({ path: 'src/New.tsx', operation: 'create' }), change()],
        steps: ['check'],
      },
      files,
    );

    expect(JSON.stringify(files)).toBe(before);
  });

  it('says so in what it returns to the model', () => {
    const text = renderPlan(parsePlan({ goal: 'g', changes: [change()] }, FILES));

    expect(text).toMatch(/nothing has been changed yet/i);
    expect(text).toMatch(/This tool changed nothing/i);
  });

  it('tells the agent to stop rather than improvise if the plan was wrong', () => {
    const text = renderPlan(parsePlan({ goal: 'g', changes: [change()] }, FILES));

    expect(text).toMatch(/say so if you find it was wrong rather than improvising/i);
  });
});

describe('a plan checked against reality', () => {
  /** "create" over an existing file is an overwrite wearing the wrong word. */
  it('refuses to call an overwrite a creation', () => {
    expect(() =>
      parsePlan({ goal: 'g', changes: [change({ operation: 'create' })] }, FILES),
    ).toThrow(/already exists.*modification/i);
  });

  it.each(['modify', 'delete'])('refuses to %s a file that is not there', (operation) => {
    expect(() =>
      parsePlan({ goal: 'g', changes: [change({ path: 'src/Gone.tsx', operation })] }, FILES),
    ).toThrow(/does not exist/i);
  });
});

describe('what a plan may not contain', () => {
  it.each(['/etc/passwd', 'C:\\Windows\\win.ini'])('refuses the absolute path %s', (path) => {
    expect(() => parsePlan({ goal: 'g', changes: [change({ path })] }, FILES)).toThrow(
      /absolute path/i,
    );
  });

  it('refuses a path the workspace policy blocks', () => {
    expect(() => parsePlan({ goal: 'g', changes: [change({ path: '.env' })] }, FILES)).toThrow(
      /workspace policy/i,
    );
  });

  /** Guessing "modify" for an unknown verb puts a wrong word in front of a user. */
  it('refuses an operation it does not know', () => {
    expect(() =>
      parsePlan({ goal: 'g', changes: [change({ operation: 'rename' })] }, FILES),
    ).toThrow(/must be one of/i);
  });

  it('refuses the same file twice', () => {
    expect(() =>
      parsePlan({ goal: 'g', changes: [change(), change()] }, FILES),
    ).toThrow(/appears twice/i);
  });

  it('refuses a change with no reason', () => {
    expect(() =>
      parsePlan({ goal: 'g', changes: [change({ reason: '  ' })] }, FILES),
    ).toThrow(/needs a "reason"/i);
  });

  it.each([
    [{ changes: [change()] }, /"goal" must be/i],
    [{ goal: 'g' }, /"changes" must be/i],
    [{ goal: 'g', changes: [] }, /"changes" must be/i],
    [{ goal: 'g', changes: ['not an object'] }, /must be an object/i],
    [{ goal: '   ', changes: [change()] }, /"goal" must be/i],
  ])('refuses malformed input %#', (input, message) => {
    expect(() => parsePlan(input as Record<string, unknown>, FILES)).toThrow(message);
  });

  it('refuses a plan larger than the cap rather than silently trimming it', () => {
    const files: Record<string, string> = {};
    const changes: Array<Record<string, unknown>> = [];
    for (let index = 0; index <= MAX_PLANNED_CHANGES; index += 1) {
      files[`src/f${index}.ts`] = 'x';
      changes.push(change({ path: `src/f${index}.ts` }));
    }

    expect(() => parsePlan({ goal: 'g', changes }, files)).toThrow(/at most 40 files/i);
  });

  it('clips an over-long reason rather than refusing the plan', () => {
    const plan = parsePlan({ goal: 'g', changes: [change({ reason: 'x'.repeat(900) })] }, FILES);

    expect(plan.changes[0].reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
  });
});

describe('comparing a plan with what happened', () => {
  const plan = parsePlan(
    {
      goal: 'g',
      changes: [change(), change({ path: 'src/lib/helper.ts' })],
    },
    FILES,
  );

  it('reports what was done', () => {
    expect(comparePlan(plan, ['src/App.tsx']).done).toEqual(['src/App.tsx']);
  });

  it('reports what was planned and not done', () => {
    expect(comparePlan(plan, ['src/App.tsx']).notDone).toEqual(['src/lib/helper.ts']);
  });

  /** The one a reviewer most needs: a file changed that nobody planned. */
  it('reports a change nobody planned', () => {
    expect(comparePlan(plan, ['src/App.tsx', 'src/Secret.ts']).unplanned).toEqual(['src/Secret.ts']);
  });

  it('reports nothing when the plan was followed exactly', () => {
    const result = comparePlan(plan, ['src/App.tsx', 'src/lib/helper.ts']);

    expect(result.notDone).toEqual([]);
    expect(result.unplanned).toEqual([]);
  });
});
