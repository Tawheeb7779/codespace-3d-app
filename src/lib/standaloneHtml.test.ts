import { describe, expect, it } from 'vitest';
import { findEntry } from '@/lib/preview';
import { getTemplate, TEMPLATES } from '@/lib/templates';

/**
 * An ordinary HTML page is an ordinary HTML page.
 *
 * A standalone document — a `<style>`, some markup, an inline `<script>`, no
 * build step — named no script to load, so it fell past the first check in
 * `findEntry` and landed on the conventional-entry list. In a project that
 * still had a template's `src/main.tsx` in it, the preview bundled that and
 * injected it into the author's document, and what the user saw was the React
 * entry's own assertion failing:
 *
 *   Uncaught Error: Root element #root is missing from index.html
 *
 * True, and none of their business. `#root` is one framework's convention.
 * A browser IDE does not get to require it of every HTML file, and it must not
 * run a program the author never referenced.
 *
 * These tests are about the decision, not the rendering: whether the preview
 * bundles a foreign entry for a document that already carries its own code.
 * That decision is `findEntry`, and it is where the bug was. Building the
 * document is `buildPreview`, which needs esbuild-wasm and therefore a browser
 * — `e2e/preview-matrix.mjs` covers that side.
 */

/** The page from the report, unchanged. */
const BIRTHDAY = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>عيد ميلاد سعيد 🎂</title>
<style>
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0614;
  color: white;
  font-family: Arial, sans-serif;
}
.card {
  padding: 40px;
  text-align: center;
}
button {
  padding: 15px 30px;
}
#message {
  display: none;
}
</style>
</head>
<body>

<div class="card">
  <h1>عيد ميلاد سعيد 🎉</h1>
  <p>أتمنى لك سنة مليانة فرح ونجاح ❤️</p>
  <button onclick="birthday()">اضغط هنا 🎁</button>
  <div id="message">🎉 كل عام وأنت بخير ❤️</div>
</div>

<script>
function birthday() {
  document.getElementById("message").style.display = "block";
}
</script>

</body>
</html>
`;

/** What a template leaves behind in a project someone then rewrote by hand. */
const LEFTOVER_REACT_ENTRY = getTemplate('react-ts').files['src/main.tsx'];

describe('a standalone HTML document', () => {
  /**
   * The acceptance case. With a leftover React entry present, this is exactly
   * the project that produced the reported error.
   */
  it('runs as authored rather than bundling a leftover React entry', () => {
    const entry = findEntry({
      'index.html': BIRTHDAY,
      'src/main.tsx': LEFTOVER_REACT_ENTRY,
    });

    expect(entry).toBeNull();
  });

  it('does not require a #root element to be runnable', () => {
    expect(BIRTHDAY).not.toContain('id="root"');

    expect(findEntry({ 'index.html': BIRTHDAY })).toBeNull();
  });

  /** The assertion that was being run against the author's page. */
  it('never reaches the entry that raises the #root error', () => {
    expect(LEFTOVER_REACT_ENTRY).toContain('Root element #root is missing');

    const entry = findEntry({
      'index.html': BIRTHDAY,
      'src/main.tsx': LEFTOVER_REACT_ENTRY,
    });

    expect(entry).not.toBe('src/main.tsx');
  });

  it('keeps its own markup, styles and handlers to hand to the preview', () => {
    // The no-entry path in `buildPreview` serves the document itself, so what
    // the author wrote is what runs: the stylesheet, the element the script
    // looks up, and the attribute handler that calls it.
    expect(BIRTHDAY).toContain('<style>');
    expect(BIRTHDAY).toContain('id="message"');
    expect(BIRTHDAY).toContain('onclick="birthday()"');
    expect(BIRTHDAY).toContain('document.getElementById("message")');
  });

  it('is taken at its word whatever else is lying around the project', () => {
    const entry = findEntry({
      'index.html': BIRTHDAY,
      'src/main.tsx': LEFTOVER_REACT_ENTRY,
      'src/main.js': 'console.log(1)',
      'index.js': 'console.log(2)',
      'app.js': 'console.log(3)',
    });

    expect(entry).toBeNull();
  });
});

describe('a page that looks up an element its own markup declares', () => {
  const page = `<!doctype html>
<html>
  <body>
    <div id="message"></div>
    <script>
      document.getElementById('message').textContent = 'ready';
    </script>
  </body>
</html>`;

  it('needs no entry point of its own', () => {
    expect(findEntry({ 'index.html': page, 'src/main.tsx': LEFTOVER_REACT_ENTRY })).toBeNull();
  });

  it('still declares the element the script reaches for', () => {
    expect(page).toContain('id="message"');
    expect(page).toContain("getElementById('message')");
  });
});

describe('inline CSS and inline JavaScript together', () => {
  const page = `<!doctype html>
<html>
  <head><style>body { background: #000; }</style></head>
  <body>
    <button id="go">go</button>
    <script>
      document.querySelector('#go').addEventListener('click', () => {
        document.body.classList.add('clicked');
      });
    </script>
  </body>
</html>`;

  it('runs as one document with nothing appended', () => {
    expect(findEntry({ 'index.html': page })).toBeNull();
  });
});

describe('what must not change', () => {
  /** A module the page loads is still the entry, inline script or not. */
  it('still prefers a local script the page actually loads', () => {
    const files = {
      'index.html':
        '<script type="module" src="./src/boot.js"></script><script>console.log("also")</script>',
      'src/boot.js': '',
      'src/main.js': '',
    };

    expect(findEntry(files)).toBe('src/boot.js');
  });

  /** A remote script is a dependency, not the program; this is unchanged. */
  it('still falls through past a remote script tag', () => {
    const files = {
      'index.html': '<script src="https://cdn.example.com/x.js"></script>',
      'src/main.ts': '',
    };

    expect(findEntry(files)).toBe('src/main.ts');
  });

  /** A page that says nothing about what to run still gets the convention. */
  it('still finds a conventional entry for a page with no script at all', () => {
    const files = {
      'index.html': '<!doctype html><html><body><div id="root"></div></body></html>',
      'src/main.tsx': LEFTOVER_REACT_ENTRY,
    };

    expect(findEntry(files)).toBe('src/main.tsx');
  });

  it('still finds an entry when there is no page at all', () => {
    expect(findEntry({ 'src/main.tsx': '' })).toBe('src/main.tsx');
    expect(findEntry({ 'index.js': '' })).toBe('index.js');
  });

  it('still returns null when there is nothing to run', () => {
    expect(findEntry({ 'README.md': '' })).toBeNull();
  });

  /**
   * The React and Vite templates load their entry from index.html, so they
   * take the first branch and are untouched by any of this. An empty script
   * body must not be mistaken for a program either.
   */
  it.each(
    TEMPLATES.filter((template) => template.runnable).map(
      (template) => [template.name, template] as const,
    ),
  )('%s still resolves its own entry point', (_name, template) => {
    expect(findEntry(template.files)).not.toBeNull();
  });

  it('treats an empty inline script as no program', () => {
    const files = {
      'index.html': '<script></script><script>   </script>',
      'src/main.ts': '',
    };

    expect(findEntry(files)).toBe('src/main.ts');
  });
});
