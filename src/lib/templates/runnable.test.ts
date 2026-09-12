import { describe, expect, it } from 'vitest';
import { TEMPLATES, getTemplate } from '@/lib/templates';

/**
 * A template that offers Run must be able to run.
 *
 * The Empty project declared `runnable: true` and shipped a README and an empty
 * `src/`. Nothing there is an entry point, so the preview fell back to
 * synthesising its own document — whose only hooks are a `#root` and an `#app`
 * nobody wrote and nobody can see. A user who followed the empty state's advice
 * ("add src/main.js, then press Run") and then wrote ordinary DOM code got
 * `Cannot read properties of null (reading 'addEventListener')` from a page
 * they had not authored, reported as a runtime error in their own code.
 *
 * These are the two properties that make that impossible rather than fixed:
 * a runnable template has an entry point, and its starter script only reaches
 * for elements its own markup actually contains.
 */

/** The paths `findEntry` accepts, mirrored here so the contract is asserted. */
const ENTRY_PATHS = [
  'index.html',
  'public/index.html',
  'src/main.ts',
  'src/main.tsx',
  'src/main.js',
  'src/main.jsx',
];

const runnable = TEMPLATES.filter((template) => template.runnable);

/** Every `#id` a script reaches for, from the query forms these templates use. */
function queriedIds(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/querySelector(?:All)?\s*<[^>]*>?\s*\(\s*['"`]#([\w-]+)/g)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/querySelector(?:All)?\s*\(\s*['"`]#([\w-]+)/g)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/getElementById\s*\(\s*['"`]([\w-]+)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

const isScript = (path: string) => /\.(?:js|jsx|ts|tsx)$/.test(path);

describe('every runnable template', () => {
  it('there is at least one, or this suite is asserting nothing', () => {
    expect(runnable.length).toBeGreaterThan(0);
  });

  it.each(runnable.map((template) => [template.name, template] as const))(
    '%s ships an entry point the preview can find',
    (_name, template) => {
      const entries = ENTRY_PATHS.filter((path) => path in template.files);

      expect(entries.length).toBeGreaterThan(0);
    },
  );

  /**
   * The failure this file exists for. A selector with no element is null, and
   * the next line is a property access on null.
   */
  it.each(runnable.map((template) => [template.name, template] as const))(
    '%s only queries elements its own markup declares',
    (_name, template) => {
      const markup = Object.entries(template.files)
        .filter(([path]) => path.endsWith('.html'))
        .map(([, content]) => content)
        .join('\n');

      const missing: string[] = [];
      for (const [path, content] of Object.entries(template.files)) {
        if (!isScript(path)) continue;
        for (const id of queriedIds(content)) {
          if (!new RegExp(`id=["']${id}["']`).test(markup)) missing.push(`${path} → #${id}`);
        }
      }

      expect(missing).toEqual([]);
    },
  );
});

describe('the Empty project, which is where this went wrong', () => {
  const blank = getTemplate('blank');

  it('is runnable and says so truthfully', () => {
    expect(blank.runnable).toBe(true);
    expect(ENTRY_PATHS.some((path) => path in blank.files)).toBe(true);
  });

  it('ships markup, so the preview never has to invent a document', () => {
    expect(blank.files['index.html']).toBeTruthy();
  });

  /** The exact shape of the original crash, asserted on the shipped files. */
  it('wires its script to an element that exists', () => {
    const ids = queriedIds(blank.files['src/main.js'] ?? '');

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(blank.files['index.html']).toContain(`id="${id}"`);
    }
  });
});

describe('a template that declines to run says why', () => {
  it.each(
    TEMPLATES.filter((template) => !template.runnable).map(
      (template) => [template.name, template] as const,
    ),
  )('%s carries a note explaining it', (_name, template) => {
    expect(template.runnableNote?.trim()).toBeTruthy();
  });
});
