import { describe, expect, it } from 'vitest';
import {
  classAttribute,
  locateElement,
  planClassEdit,
  planTextEdit,
  readSelection,
  type Selection,
} from '@/lib/uibuilder/locate';

/**
 * Matching a rendered element back to a line, and refusing to when it is a
 * guess.
 *
 * There is no source map from the preview's bundle back to source, so this is a
 * text search. That is fine as long as it never *presents* as more: two lines
 * that match equally well must both come back, an element whose text is
 * computed must produce a stated reason rather than a plausible wrong line, and
 * an edit whose target has moved must be refused rather than written near where
 * it used to be. A wrong replacement in somebody's source, reported as a
 * success, is the failure this module exists to prevent.
 */

function select(partial: Partial<Selection> = {}): Selection {
  return { tag: 'button', id: null, classes: [], text: null, path: 'body > button', ...partial };
}

describe('reading the class attribute off a line', () => {
  it('reads a JSX className', () => {
    expect(classAttribute('<div className="a b">')).toMatchObject({ value: 'a b', quote: '"' });
  });

  it('reads a plain HTML class', () => {
    expect(classAttribute("<div class='a b'>")).toMatchObject({ value: 'a b', quote: "'" });
  });

  it('finds none when there is none', () => {
    expect(classAttribute('<div>')).toBeNull();
  });

  /** An expression is not a literal, and rewriting one would destroy it. */
  it('does not treat a JSX expression as a literal', () => {
    expect(classAttribute('<div className={cx("a", b)}>')).toBeNull();
  });
});

describe('finding the line', () => {
  const files = {
    'src/App.tsx': [
      'export function App() {',
      '  return (',
      '    <div id="root-shell">',
      '      <button className="btn primary">Save</button>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
  };

  it('matches on an id', () => {
    const result = locateElement(files, select({ tag: 'div', id: 'root-shell' }));

    expect(result.candidates[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 3,
      confidence: 'exact',
    });
    expect(result.candidates[0].matchedOn).toContain('id');
  });

  it('matches on the class string and the tag', () => {
    const result = locateElement(files, select({ classes: ['btn', 'primary'] }));

    expect(result.candidates[0]).toMatchObject({ line: 4, confidence: 'likely' });
    expect(result.candidates[0].matchedOn).toEqual(expect.arrayContaining(['class', 'tag']));
  });

  it('matches on text and the tag', () => {
    const result = locateElement(files, select({ text: 'Save' }));

    expect(result.candidates[0].line).toBe(4);
    expect(result.candidates[0].matchedOn).toContain('text');
  });

  it('carries the line itself, so it can be checked before editing', () => {
    const result = locateElement(files, select({ text: 'Save' }));

    expect(result.candidates[0].source).toContain('<button className="btn primary">Save</button>');
  });

  it('does not match a class string that is only a subset', () => {
    const result = locateElement(files, select({ classes: ['btn'] }));

    expect(result.candidates.every((candidate) => !candidate.matchedOn.includes('class'))).toBe(
      true,
    );
  });

  it('ignores build output and dependencies', () => {
    const result = locateElement(
      { 'dist/App.tsx': files['src/App.tsx'], 'node_modules/x/App.tsx': files['src/App.tsx'] },
      select({ id: 'root-shell', tag: 'div' }),
    );

    expect(result.candidates).toEqual([]);
  });

  it('ignores files that cannot contain markup', () => {
    const result = locateElement({ 'notes.md': '<button class="btn">Save</button>' }, select({ text: 'Save' }));

    expect(result.candidates).toEqual([]);
  });

  /**
   * The honesty guard. An element built from a variable has no literal, and
   * offering a nearby line as its source is how somebody edits the wrong thing.
   */
  it('says why nothing matched, rather than offering a near miss', () => {
    const result = locateElement(files, select({ tag: 'span', text: 'Total: 42' }));

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/built at runtime/i);
    expect(result.note).toMatch(/no source map/i);
  });

  it('says there is nothing to search for when the element is bare', () => {
    const result = locateElement(files, select({ tag: 'div' }));

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/no id, no class and no text/i);
  });

  /** Two equal matches are a question for the reader, not a coin toss. */
  it('reports an ambiguous match as ambiguous', () => {
    const twice = {
      'src/A.tsx': '<button className="btn primary">Save</button>',
      'src/B.tsx': '<button className="btn primary">Save</button>',
    };
    const result = locateElement(twice, select({ classes: ['btn', 'primary'], text: 'Save' }));

    expect(result.candidates).toHaveLength(2);
    expect(result.note).toMatch(/match this element equally well/i);
  });

  /** Text found somewhere that is not the element's own tag is barely evidence. */
  it('warns when the only match is weak', () => {
    const result = locateElement(
      { 'src/A.tsx': 'const label = "Save";' },
      select({ text: 'Save' }),
    );

    expect(result.candidates[0].confidence).toBe('weak');
    expect(result.note).toMatch(/weak match/i);
  });

  it('ranks an id match above a class match', () => {
    const mixed = {
      'src/A.tsx': '<button className="btn">x</button>',
      'src/B.tsx': '<button id="save" className="btn">x</button>',
    };
    const result = locateElement(mixed, select({ id: 'save', classes: ['btn'] }));

    expect(result.candidates[0].path).toBe('src/B.tsx');
  });
});

describe('editing the text', () => {
  const file = ['<div>', '  <button>Save</button>', '</div>'].join('\n');

  it('replaces the text on the located line', () => {
    const plan = planTextEdit(file, 2, 'Save', 'Submit');

    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.next).toContain('<button>Submit</button>');
  });

  it('leaves every other line alone', () => {
    const plan = planTextEdit(file, 2, 'Save', 'Submit');

    expect(plan.ok && plan.next.split('\n')[0]).toBe('<div>');
    expect(plan.ok && plan.next.split('\n')).toHaveLength(3);
  });

  /** The file moved on: writing anyway would overwrite somebody's change. */
  it('refuses when the text is no longer on that line', () => {
    const plan = planTextEdit(file, 1, 'Save', 'Submit');

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.problem).toMatch(/not on this line any more/i);
  });

  /** Two identical labels on one line: replacing one of them is a guess. */
  it('refuses when the text appears twice on the line', () => {
    const plan = planTextEdit('<b>Save</b><i>Save</i>', 1, 'Save', 'Submit');

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.problem).toMatch(/appears 2 times/i);
  });

  it('refuses a line past the end of the file', () => {
    expect(planTextEdit(file, 99, 'Save', 'Submit').ok).toBe(false);
  });

  it('refuses an empty replacement', () => {
    expect(planTextEdit(file, 2, 'Save', '   ').ok).toBe(false);
  });
});

describe('editing the classes', () => {
  const file = '  <button className="btn primary">Save</button>';

  it('replaces the class attribute', () => {
    const plan = planClassEdit(file, 1, 'btn primary', 'btn danger');

    expect(plan.ok && plan.next).toBe('  <button className="btn danger">Save</button>');
  });

  it('keeps the quote style the source used', () => {
    const plan = planClassEdit("<div class='a'>", 1, 'a', 'b');

    expect(plan.ok && plan.next).toBe("<div class='b'>");
  });

  it('refuses when the line has no class attribute', () => {
    const plan = planClassEdit('<button>Save</button>', 1, 'btn', 'x');

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.problem).toMatch(/no class attribute/i);
  });

  /** Somebody else changed the line since it was selected. */
  it('refuses when the classes on the line are not the ones selected', () => {
    const plan = planClassEdit(file, 1, 'btn ghost', 'btn danger');

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.problem).toMatch(/re-select the element/i);
  });

  /** A quote in a class name would close the attribute and rewrite the tag. */
  it.each(['btn" onclick="x', "btn' x", 'a<b', 'a>b'])('refuses "%s"', (classes) => {
    expect(planClassEdit(file, 1, 'btn primary', classes).ok).toBe(false);
  });
});

describe('reading a selection off the preview', () => {
  it('accepts a well-formed one', () => {
    expect(
      readSelection({ tag: 'BUTTON', id: 'save', classes: ['a'], text: ' Save ', path: 'body > button' }),
    ).toEqual({ tag: 'button', id: 'save', classes: ['a'], text: ' Save ', path: 'body > button' });
  });

  /**
   * This arrives from a sandboxed frame running the user's own bundle, so it is
   * foreign data, not a value this app produced.
   */
  it.each([null, 'a string', { tag: '<script>' }, { tag: '' }, { classes: ['a'] }])(
    'refuses %s',
    (data) => {
      expect(readSelection(data)).toBeNull();
    },
  );

  it('caps a huge text', () => {
    const selection = readSelection({ tag: 'p', text: 'x'.repeat(10_000) });

    expect(selection?.text?.length).toBeLessThanOrEqual(200);
  });

  it('caps the number and length of classes', () => {
    const selection = readSelection({
      tag: 'p',
      classes: Array.from({ length: 500 }, () => 'y'.repeat(500)),
    });

    expect(selection?.classes.length).toBeLessThanOrEqual(40);
    expect(selection?.classes[0].length).toBeLessThanOrEqual(80);
  });

  it('drops a non-string class', () => {
    expect(readSelection({ tag: 'p', classes: ['a', 3, null] })?.classes).toEqual(['a']);
  });

  it('treats empty text as no text', () => {
    expect(readSelection({ tag: 'p', text: '   ' })?.text).toBeNull();
  });
});
