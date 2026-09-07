/**
 * Does the work survive a reload?
 *
 * The reported failure was precise: a newly created file appears in the editor,
 * and after Save + browser Refresh it is gone, with nothing having said a save
 * failed. This drives that journey for real — create, edit, save, reload,
 * reopen — and then forces the save to fail and checks the failure is visible
 * rather than silent, which is what made the original bug so hard to see.
 *
 *   node e2e/persistence.mjs
 *
 * FORGE_E2E_CHROMIUM overrides the browser binary; FORGE_E2E_BASE the origin.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? 'e2e/artifacts';
mkdirSync(OUT, { recursive: true });
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;

const pageErrors = [];
let passed = 0;
let failed = 0;

const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
// A reload with unsaved work now asks first; a test drives past it the way a
// person clicking "leave" does.
page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(
      `FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`,
    );
    await page
      .screenshot({ path: `${OUT}/persistence-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
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

/** Run a command by name through the real palette. */
const runCommand = async (label) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10000 });
  await page.getByLabel('Search commands').fill(`>${label}`);
  await page.waitForTimeout(300);
  await page.getByRole('option').filter({ hasText: label }).first().click({ timeout: 10000 });
  await page.waitForTimeout(600);
};

const sidebarText = async () => page.locator('aside').first().innerText();
const editorText = async () =>
  (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/ /g, ' ');

const MARKER = `persisted-${Date.now()}`;
const NEW_FILE = 'src/persisted-check.ts';
let projectUrl = '';

try {
  await step('1. create a project and reach its workspace', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`Persistence ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2000);
    projectUrl = page.url();
    assert(/\/project\//.test(projectUrl), `no project url: ${projectUrl}`);
  });

  await step('2. a new file is created and appears in the explorer', async () => {
    await runCommand('New file');
    const input = page.getByLabel('New file name');
    await input.waitFor({ timeout: 10000 });
    await input.fill(NEW_FILE);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    assert(
      (await sidebarText()).includes('persisted-check.ts'),
      'the new file is not listed in the explorer',
    );
  });

  await step('3. typing into it marks the project dirty', async () => {
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type(`export const marker = '${MARKER}';`);
    await page.waitForTimeout(400);
    const footer = await page.locator('footer').innerText();
    assert(/unsaved|saving/i.test(footer), `the status bar did not report unsaved work: ${footer}`);
  });

  await step('4. saving reports a real success, not just silence', async () => {
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1500);
    const footer = await page.locator('footer').innerText();
    assert(/saved/i.test(footer), `the status bar does not say the work was saved: ${footer}`);
    assert(
      !/not saved/i.test(footer),
      `the status bar reports a failed save: ${footer}`,
    );
  });

  await step('5. the file and its contents survive a full reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);

    assert(
      (await sidebarText()).includes('persisted-check.ts'),
      'the file is gone from the explorer after the reload',
    );
  });

  await step('6. reopening the file shows what was typed into it', async () => {
    await page.getByText('persisted-check.ts').first().click();
    await page.waitForTimeout(1200);
    const text = await editorText();
    assert(text.includes(MARKER), `the contents did not survive: ${text.slice(0, 120)}`);
  });

  await step('7. an empty folder survives a reload too', async () => {
    await runCommand('New folder');
    const input = page.getByLabel('New folder name');
    await input.waitFor({ timeout: 10000 });
    // A name is relative to the folder the creation started in, which is the
    // active file's folder — the same rule other editors use.
    await input.fill('empty-check');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    assert(
      (await sidebarText()).includes('empty-check'),
      'the folder was never created in the first place',
    );
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    const tree = await sidebarText();
    assert(
      tree.includes('empty-check'),
      `the empty folder did not survive; explorer shows: ${tree.replace(/\n/g, ' | ')}`,
    );
  });

  await step('8. leaving the dashboard and coming back keeps everything', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2500);
    const text = await sidebarText();
    assert(text.includes('persisted-check.ts'), 'the file is gone after switching projects');
    assert(text.includes('empty-check'), 'the folder is gone after switching projects');
  });

  // ------------------------------------------------------------------------
  // The other half: a save that cannot succeed must say so.
  // ------------------------------------------------------------------------

  await step('9. a save that fails is reported, not swallowed', async () => {
    // Break persistence underneath the app, the way a refusing policy does.
    await page.evaluate(() => {
      const open = indexedDB.open;
      // Any write to the project store now throws; reads are untouched, so the
      // editor still looks perfectly healthy.
      window.__breakWrites = true;
      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
        if (window.__breakWrites && mode === 'readwrite') {
          throw new DOMException('storage refused the write', 'InvalidStateError');
        }
        return originalTransaction.call(this, names, mode, ...rest);
      };
      void open;
    });

    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type('// a change that cannot be stored');
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(2000);

    const alerted = await page
      .getByText(/Your changes are not saved/i)
      .first()
      .isVisible()
      .catch(() => false);
    assert(alerted, 'nothing on screen said the save failed');
  });

  await step('10. the status bar distinguishes a failure from ordinary unsaved work', async () => {
    const footer = await page.locator('footer').innerText();
    assert(/not saved/i.test(footer), `the status bar still reads as normal: ${footer}`);
  });

  await step('11. the failure is written where it can be read back in full', async () => {
    await page.getByRole('tab', { name: /output/i }).first().click({ timeout: 8000 });
    await page.waitForTimeout(600);
    const output = await page.locator('main, body').first().innerText();
    assert(/save failed/i.test(output), 'the output panel has no record of the failure');
  });

  await step('12. recovering re-saves the work rather than staying stuck', async () => {
    await page.evaluate(() => {
      window.__breakWrites = false;
    });
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(2000);
    const footer = await page.locator('footer').innerText();
    assert(/saved/i.test(footer) && !/not saved/i.test(footer), `still failing: ${footer}`);
  });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('--- page errors ---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
  process.exit(failed ? 1 : 0);
}
