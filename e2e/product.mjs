/**
 * The whole product, driven once, the way a person uses it.
 *
 * The other suites each prove one subsystem. This one walks the journey end to
 * end — sign in, create, edit, save, reload, rename, delete, tabs, split,
 * search, problems, palette, terminal, preview, panels, mobile, project
 * switching, sign out — and fails on a console error or a React reconciliation
 * crash anywhere along the way, because a step that "passes" while the console
 * is on fire has not passed.
 *
 * It also checks the things a redesign can quietly break: that the branding is
 * the product's own, that the palette in the browser is the palette in the
 * stylesheet, and that the workspace ground never lands on top of the code.
 *
 *   node e2e/product.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? 'e2e/artifacts';
mkdirSync(OUT, { recursive: true });
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;

const consoleErrors = [];
const pageErrors = [];
let passed = 0;
let failed = 0;

const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

const step = async (name, fn) => {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(
      `FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`,
    );
    await page
      .screenshot({ path: `${OUT}/product-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
      .catch(() => {});
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const skipOnboarding = async () => {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(400);
  }
};

const runCommand = async (label) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10000 });
  await page.getByLabel('Search commands').fill(`>${label}`);
  await page.waitForTimeout(300);
  await page.getByRole('option').filter({ hasText: label }).first().click({ timeout: 10000 });
  await page.waitForTimeout(600);
};

const sidebar = async () => page.locator('aside').first().innerText();
const showPanel = async (name) => {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForTimeout(400);
};

const MARKER = `ta-${Date.now()}`;
let firstProject = '';
let secondProject = '';

try {
  // ------------------------------------------------------------- identity

  await step('1. the product introduces itself as TA CODE', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const title = await page.title();
    assert(/TA CODE/.test(title), `the tab says: ${title}`);
    const header = await page.locator('header').first().innerText();
    assert(/TA\s*CODE/.test(header), `the header says: ${header.replace(/\n/g, ' ')}`);
    assert(!/\bForge\b/.test(await page.locator('body').innerText()), 'the old name is still on the page');
    return title;
  });

  await step('2. the palette the browser renders is the palette in the stylesheet', async () => {
    const tokens = await page.evaluate(() => {
      const read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return {
        canvas: read('--c-canvas'),
        accent: read('--c-accent'),
        ink: read('--c-ink'),
      };
    });
    assert(tokens.canvas === '11 13 16', `canvas is ${tokens.canvas}`);
    assert(tokens.accent === '56 176 214', `accent is ${tokens.accent}`);
    assert(tokens.ink === '227 231 237', `ink is ${tokens.ink}`);
    return `accent rgb(${tokens.accent})`;
  });

  // ------------------------------------------------------- sign in, project

  await step('3. sign in and reach the dashboard', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    assert(/dashboard/.test(page.url()), page.url());
  });

  await step('4. create a project and open its workspace', async () => {
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`TA one ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2000);
    firstProject = page.url();
  });

  await step('5. the editor sits on the ground, not under it', async () => {
    // The background treatment must be behind the panels. If any of it were
    // painted over the editor, the code would be sitting on a grid.
    const layered = await page.evaluate(() => {
      const lines = document.querySelector('.monaco-editor .view-lines');
      if (!lines) return null;
      const box = lines.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + 40, box.top + 10);
      return {
        onGround: Boolean(top?.closest('.ta-ground')) && !top?.closest('.monaco-editor'),
        opaque: getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor,
      };
    });
    assert(layered, 'no editor on screen');
    assert(!layered.onGround, 'the ground is painted over the editor');
    assert(!/rgba\(0, 0, 0, 0\)/.test(layered.opaque), `the editor is transparent: ${layered.opaque}`);
    return `editor background ${layered.opaque}`;
  });

  // ------------------------------------------------------ files and folders

  await step('6. create a folder, then a file inside it', async () => {
    await runCommand('New folder');
    const folder = page.getByLabel('New folder name');
    await folder.waitFor({ timeout: 10000 });
    await folder.fill('ta-check');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    assert((await sidebar()).includes('ta-check'), 'the folder is not in the tree');

    await runCommand('New file');
    const file = page.getByLabel('New file name');
    await file.waitFor({ timeout: 10000 });
    await file.fill('ta-check/note.ts');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    assert((await sidebar()).includes('note.ts'), 'the file is not in the tree');
  });

  await step('7. edit it, and the status bar reports unsaved work', async () => {
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type(`export const marker = '${MARKER}';`);
    await page.waitForTimeout(500);
    const footer = await page.locator('footer').innerText();
    assert(/unsaved|saving/i.test(footer), footer.replace(/\n/g, ' '));
  });

  await step('8. save, and the status bar says so', async () => {
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1500);
    const footer = await page.locator('footer').innerText();
    assert(/saved/i.test(footer) && !/not saved/i.test(footer), footer.replace(/\n/g, ' '));
  });

  await step('9. the file and its contents survive a reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    assert((await sidebar()).includes('ta-check'), 'the folder is gone');
    // The restored session reopens the file, which expands the folder holding it.
    assert((await sidebar()).includes('note.ts'), 'the file is gone');
    await page.getByText('note.ts').first().click();
    await page.waitForTimeout(1200);
    const text = await page.locator('.monaco-editor .view-lines').first().innerText();
    assert(text.includes(MARKER), `contents lost: ${text.slice(0, 80)}`);
  });

  await step('10. duplicate, rename and delete all do what they say', async () => {
    await showPanel('Explorer');
    // Deliberately a file at the root: this step renames and deletes what it
    // duplicates, and it must not be able to disturb the nested file that the
    // project-switching step later looks for.
    const row = page.getByText('index.html').first();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Duplicate/i }).click({ timeout: 8000 });
    await page.waitForTimeout(900);
    assert(/note copy|note-copy|note\(1\)|copy/i.test(await sidebar()), 'nothing was duplicated');

    // Rename the duplicate, then delete it, so the tree ends where it started.
    // Rename opens a dialog rather than editing in the tree, so the new name is
    // typed into a labelled field and confirmed.
    const copy = page.locator('[role="treeitem"]').filter({ hasText: /copy/i }).first();
    await copy.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Rename/i }).click({ timeout: 8000 });
    await page.getByRole('dialog', { name: 'Rename' }).waitFor({ timeout: 8000 });
    await page.getByLabel('New name').fill('renamed.html');
    await page.getByRole('button', { name: /^Rename$/ }).click();
    await page.waitForTimeout(900);
    assert((await sidebar()).includes('renamed.html'), 'the rename did not take');

    await page.getByText('renamed.html').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Delete/i }).click({ timeout: 8000 });
    const confirm = page.getByRole('button', { name: /^Delete$/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.waitForTimeout(900);
    assert(!(await sidebar()).includes('renamed.html'), 'the delete did not take');
  });

  // -------------------------------------------------------------- editor

  await step('11. tabs, split editor and quick open all work together', async () => {
    for (const name of ['index.html', 'styles.css']) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+P');
      await page.getByRole('dialog', { name: 'Open file' }).waitFor({ timeout: 8000 });
      await page.getByLabel('Search files').fill(name);
      await page.waitForTimeout(300);
      await page.getByRole('option').first().click({ timeout: 8000 });
      await page.waitForTimeout(500);
    }
    const tabs = await page.locator('[role="tablist"][aria-label="Open editors"] [role="tab"]').count();
    assert(tabs >= 2, `only ${tabs} tab(s) open`);

    await page.getByRole('button', { name: /Split editor/i }).first().click();
    await page.waitForTimeout(900);
    assert((await page.locator('.monaco-editor').count()) >= 2, 'the split pane did not open');
    await page.getByRole('button', { name: /Close split view/i }).first().click();
    await page.waitForTimeout(600);
    return `${tabs} tabs`;
  });

  await step('12. search finds a real match across the project', async () => {
    await showPanel('Search');
    await page.getByLabel('Search across files').fill(MARKER);
    await page.waitForTimeout(1500);
    assert((await sidebar()).includes('note.ts'), `no result for ${MARKER}`);
  });

  await step('13. the problems panel reports a real diagnostic', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByRole('dialog', { name: 'Open file' }).waitFor({ timeout: 8000 });
    await page.getByLabel('Search files').fill('note.ts');
    await page.waitForTimeout(300);
    await page.getByRole('option').first().click({ timeout: 8000 });
    await page.waitForTimeout(800);
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nconst broken: number = "not a number";');
    await page.waitForTimeout(3500);
    await page.getByRole('tab', { name: /problems/i }).first().click();
    await page.waitForTimeout(1200);
    const panel = await page.locator('body').innerText();
    assert(/not assignable|Type '/.test(panel), 'the type error never reached the panel');
  });

  // ------------------------------------------------- terminal and preview

  await step('14. the terminal opens, closes and reopens', async () => {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Control+`');
      await page.waitForTimeout(500);
    }
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(600);
    assert(await page.locator('.xterm').first().isVisible(), 'the terminal is not showing');
    assert((await page.locator('.xterm').count()) === 1, 'more than one terminal was created');
  });

  await step('15. run, stop and run the preview again', async () => {
    // The preview pane may be closed by now, and auto-run means it may already
    // be running — the same button is Stop in that state. Both are ordinary,
    // so get to a known state first rather than assuming one.
    const runButton = page.getByRole('button', { name: /run the project/i });
    const stopButton = page.getByRole('button', { name: /stop the preview/i });
    if (!(await page.locator('[aria-label="Live preview"]').isVisible().catch(() => false))) {
      await runCommand('Toggle preview');
      await page.waitForTimeout(800);
    }
    if (await stopButton.isVisible().catch(() => false)) {
      await stopButton.click();
      await page.waitForTimeout(900);
    }

    await runButton.click({ timeout: 10000 });
    await page.waitForTimeout(3500);
    assert(
      await page.locator('iframe[title="Project preview"]').isVisible(),
      'the preview never appeared',
    );

    await stopButton.click({ timeout: 10000 });
    await page.waitForTimeout(900);
    assert(
      await page.getByText(/Preview is stopped/i).isVisible(),
      'stopping left the preview showing',
    );

    await runButton.click({ timeout: 10000 });
    await page.waitForTimeout(3500);
    assert(
      await page.locator('iframe[title="Project preview"]').isVisible(),
      'the preview did not come back',
    );
  });

  await step('16. the preview stays sandboxed after the redesign', async () => {
    const frame = page.locator('iframe[title="Project preview"]');
    if (!(await frame.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /run the project/i }).click({ timeout: 10000 });
      await page.waitForTimeout(3500);
    }
    const sandbox = await frame.getAttribute('sandbox', { timeout: 10000 });
    assert(sandbox, 'the preview iframe has no sandbox attribute');
    assert(!/allow-same-origin/.test(sandbox), `the sandbox was widened: ${sandbox}`);
    return sandbox;
  });

  // -------------------------------------------------------------- layout

  await step('17. panels resize, and the drag follows the whole way', async () => {
    const handle = page.getByRole('separator', { name: /resize sidebar/i }).first();
    const box = await handle.boundingBox();
    const width = () => page.evaluate(() => document.querySelector('aside')?.getBoundingClientRect().width ?? 0);
    const before = await width();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + i * 8, box.y + box.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await width();
    assert(after - before > 40, `${before.toFixed(0)} -> ${after.toFixed(0)}`);
    return `${before.toFixed(0)}px -> ${after.toFixed(0)}px`;
  });

  await step('18. every visible control still has an accessible name', async () => {
    const nameless = await page.evaluate(() => {
      const named = (el) =>
        Boolean(
          el.getAttribute('aria-label')?.trim() ||
            el.getAttribute('title')?.trim() ||
            el.textContent?.trim() ||
            [...el.querySelectorAll('img[alt], svg title')].some((n) =>
              (n.getAttribute('alt') ?? n.textContent ?? '').trim(),
            ) ||
            (el.getAttribute('aria-labelledby') ?? '')
              .split(/\s+/)
              .some((id) => id && document.getElementById(id)),
        );
      return [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"]')]
        .filter((el) => !el.closest('.monaco-editor, .xterm') && el.offsetParent !== null && !named(el))
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
    });
    assert(nameless.length === 0, `${nameless.length} unnamed: ${nameless.slice(0, 4).join(' | ')}`);
  });

  for (const width of [390, 430, 834]) {
    await step(`19. the layout holds at ${width}px with no sideways scroll`, async () => {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(1200);
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert(
        overflow.scroll <= overflow.client + 1,
        `${overflow.scroll} > ${overflow.client}`,
      );
      // And the workspace is still operable, not just narrow.
      assert(await page.locator('footer').isVisible(), 'the status bar is gone');
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(800);

  // ---------------------------------------------- switching and sessions

  await step('20. a second project opens without the first one leaking in', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`TA two ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    secondProject = page.url();
    assert(secondProject !== firstProject, 'the same project opened twice');
    const tree = await sidebar();
    assert(!tree.includes('note.ts'), "the first project's files are in the second");
  });

  await step('21. switching back and forth keeps each project its own', async () => {
    await page.goto(firstProject, { waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    // The sidebar remembers which panel was last open, and an earlier step left
    // it on Search; ask for the tree before reading it.
    await showPanel('Explorer');
    // A freshly opened project starts with its folders collapsed, so the file
    // is not in the tree's text until the folder it lives in is opened.
    const firstTree = await sidebar();
    assert(
      firstTree.includes('ta-check'),
      `the first project lost its folder; tree: ${firstTree.replace(/\n/g, ' | ')}`,
    );
    // The restored session may already have reopened the file, which expands
    // the folder holding it; only click when it is actually still shut.
    if (!(await sidebar()).includes('note.ts')) {
      await page.getByText('ta-check').first().click();
      await page.waitForTimeout(700);
    }
    const opened = await sidebar();
    assert(
      opened.includes('note.ts'),
      `the first project lost its file; tree: ${opened.replace(/\n/g, ' | ')}`,
    );

    await page.goto(secondProject, { waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    await showPanel('Explorer');
    const second = await sidebar();
    assert(!second.includes('ta-check'), 'the second project picked up the first');
    assert(!second.includes('note.ts'), 'the second project picked up the first');
  });

  await step('22. signing out ends the session and protects the route', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForTimeout(2500);
    await page.goto(secondProject, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    assert(/signin|\/$/.test(page.url()), `a signed-out tab reached ${page.url()}`);
  });

  // ------------------------------------------------------------ the console

  await step('23. nothing crashed, and the console stayed clean', async () => {
    const reconciliation = pageErrors.filter((e) =>
      /removeChild|insertBefore|NotFoundError|not a child/.test(e),
    );
    assert(reconciliation.length === 0, `${reconciliation.length} reconciliation errors`);
    // The blocked package CDN is this environment, not the product.
    const real = consoleErrors.filter(
      (line) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|esm\.sh|registry\.npmjs/.test(line),
    );
    assert(real.length === 0, `${real.length} console errors: ${real.slice(0, 2).join(' | ')}`);
    assert(pageErrors.length === 0, `${pageErrors.length} page errors: ${pageErrors[0] ?? ''}`);
  });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('--- console errors ---');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
  console.log('--- page errors ---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
  process.exit(failed ? 1 : 0);
}
