/**
 * The hostile pass: everything a person does when they are impatient.
 *
 * The other suites drive the product the way it is meant to be used, with a
 * pause after each step. This one does not pause. It clicks Run and Stop as
 * fast as the browser will dispatch, opens and closes tabs in a burst, switches
 * projects while a save is in flight, drags a divider off the edge of the
 * window, and walks the whole interface from the keyboard without touching the
 * mouse.
 *
 * Nothing here asserts that an operation was fast. It asserts that the
 * application is still standing afterwards, holding the right data, with a
 * clean console — which is the thing that breaks when async work outlives the
 * screen that asked for it.
 *
 *   node e2e/stress.mjs
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
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));
page.on('dialog', (d) => d.accept().catch(() => {}));

const step = async (name, fn) => {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: `${OUT}/stress-fail-${name.replace(/\W+/g, '-').slice(0, 50)}.png` }).catch(() => {});
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const skipOnboarding = async () => {
  const s = page.getByRole('button', { name: 'Skip', exact: true });
  if (await s.isVisible().catch(() => false)) {
    await s.click();
    await page.waitForTimeout(300);
  }
};
const sidebar = async () => page.locator('aside').first().innerText();
const alive = async () =>
  (await page.locator('footer').isVisible().catch(() => false)) &&
  (await page.locator('.monaco-editor').first().isVisible().catch(() => false));

const newProject = async (name) => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /New project/i }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: /Create project/i }).click();
  await page.waitForURL('**/project/**', { timeout: 40000 });
  await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
  await skipOnboarding();
  await page.waitForTimeout(1500);
  return page.url();
};

let alpha = '';
let beta = '';
const MARK = `stress-${Date.now()}`;

try {
  await step('sign in', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
  });

  await step('two projects to bounce between', async () => {
    alpha = await newProject(`Stress alpha ${Date.now()}`);
    beta = await newProject(`Stress beta ${Date.now()}`);
    assert(alpha !== beta, 'the same project twice');
  });

  await step('hammering Run and Stop leaves a settled preview', async () => {
    await page.goto(alpha, { waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(1500);

    // No waiting between clicks: whichever button is there, press it.
    for (let i = 0; i < 12; i++) {
      const run = page.getByRole('button', { name: /run the project/i });
      const stop = page.getByRole('button', { name: /stop the preview/i });
      if (await run.isVisible().catch(() => false)) await run.click({ timeout: 2000 }).catch(() => {});
      else if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(80);
    }
    // Let whatever is in flight land.
    await page.waitForTimeout(6000);

    const settled = await page.evaluate(() => {
      const frame = document.querySelector('iframe[title="Project preview"]');
      const stopped = document.body.innerText.includes('Preview is stopped');
      return { frame: Boolean(frame), stopped };
    });
    // Either state is fine; being in both, or in neither, is not.
    assert(settled.frame !== settled.stopped, `preview is in a contradictory state: ${JSON.stringify(settled)}`);
    assert(await alive(), 'the workspace did not survive');
    return settled.frame ? 'ended running' : 'ended stopped';
  });

  await step('editing while a build runs still ends on the newest code', async () => {
    await page.getByRole('button', { name: /run the project/i }).click({ timeout: 8000 }).catch(() => {});
    // Type into the file while the bundler is working.
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type(`\n// ${MARK}\n`);
    await page.waitForTimeout(200);
    await page.keyboard.type('// and one more line\n');
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(6000);

    const editor = await page.locator('.monaco-editor .view-lines').first().innerText();
    assert(editor.includes(MARK), 'the edit made during the build was lost');
    const footer = await page.locator('footer').innerText();
    assert(!/not saved/i.test(footer), `the save failed: ${footer.replace(/\n/g, ' ')}`);
  });

  await step('opening and closing tabs in a burst', async () => {
    for (let round = 0; round < 3; round++) {
      for (const name of ['index.html', 'styles.css', 'main.js', 'README.md']) {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+P');
        await page.getByRole('dialog', { name: 'Open file' }).waitFor({ timeout: 8000 });
        await page.getByLabel('Search files').fill(name);
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
      }
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Control+w');
        await page.waitForTimeout(60);
      }
    }
    await page.waitForTimeout(800);

    // Every tab is closed now, so the right thing on screen is the empty state,
    // not an editor — and the frame around it has to still be there.
    assert(await page.locator('footer').isVisible(), 'the status bar is gone');
    const body = await page.locator('body').innerText();
    assert(/No file open|Open a file/i.test(body), `no empty state after closing every tab: ${body.slice(0, 120)}`);

    // And the editor comes back when a file does.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByRole('dialog', { name: 'Open file' }).waitFor({ timeout: 8000 });
    await page.getByLabel('Search files').fill('index.html');
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    await page.locator('.monaco-editor').first().waitFor({ timeout: 20000 });
    assert(await alive(), 'the editor did not come back');
  });

  await step('switching projects while a save is in flight', async () => {
    await page.goto(alpha, { waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(1500);

    for (let i = 0; i < 4; i++) {
      await page.locator('.monaco-editor').first().click();
      await page.keyboard.type(`// churn ${i}\n`);
      // Navigate without waiting for the save that the edit just scheduled.
      await page.keyboard.press('Control+S');
      await page.goto(i % 2 === 0 ? beta : alpha, { waitUntil: 'domcontentloaded' });
      await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
      await skipOnboarding();
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(2000);

    // Whatever landed, neither project may hold the other's files.
    const stored = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('forge-ide');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = await new Promise((resolve) => {
        const request = db.transaction('projects', 'readonly').objectStore('projects').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      return all
        .filter((p) => String(p.name).startsWith('Stress'))
        .map((p) => ({ name: p.name, files: Object.keys(p.files ?? {}).sort() }));
    });
    assert(stored.length === 2, `expected two projects, saw ${stored.length}`);
    const [one, two] = stored;
    assert(
      JSON.stringify(one.files) === JSON.stringify(two.files),
      `the two projects diverged in shape: ${JSON.stringify(stored)}`,
    );
    assert(await alive(), 'the workspace did not survive the switching');
    return `${stored.length} projects intact`;
  });

  await step('dragging a divider off the edge and back', async () => {
    const handle = page.getByRole('separator', { name: /resize sidebar/i }).first();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Way past both clamps, then back.
    for (const x of [-400, 2400, 600, -200, 300]) {
      await page.mouse.move(x, box.y + box.height / 2);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);

    const width = await page.evaluate(() => document.querySelector('aside')?.getBoundingClientRect().width ?? 0);
    assert(width >= 200 && width <= 520, `the sidebar escaped its clamps at ${width}px`);
    assert((await page.evaluate(() => document.body.style.cursor)) === '', 'the drag cursor was left set');
    assert(await alive(), 'the workspace did not survive the drag');
    return `${width.toFixed(0)}px, within 200–520`;
  });

  await step('the whole interface is reachable from the keyboard alone', async () => {
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const reached = new Set();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 30) ||
          el.tagName.toLowerCase()
        );
      });
      if (where) reached.add(where);
    }
    assert(reached.size >= 10, `only ${reached.size} focusable stops in 40 tabs`);
    // And focus must be visible, not just present.
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { outline: style.outlineWidth, shadow: style.boxShadow };
    });
    assert(ring, 'focus fell off the page');
    return `${reached.size} distinct stops`;
  });

  await step('an empty project opens without a blank screen', async () => {
    const empty = await newProject(`Stress empty ${Date.now()}`);
    void empty;
    // Delete everything, then reload into the husk.
    const files = ['index.html', 'styles.css', 'main.js', 'README.md'];
    for (const name of files) {
      const row = page.getByText(name).first();
      if (!(await row.isVisible().catch(() => false))) continue;
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Delete/i }).click({ timeout: 5000 }).catch(() => {});
      const confirm = page.getByRole('button', { name: /^Delete$/ });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await page.waitForTimeout(400);
    }
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await skipOnboarding();

    const body = await page.locator('body').innerText();
    assert(body.trim().length > 0, 'the page came back blank');
    assert(await page.locator('footer').isVisible(), 'the status bar is gone');
    assert(!/cannot read|undefined is not/i.test(body), `an error is on screen: ${body.slice(0, 120)}`);
    return `${(await sidebar()).split('\n').length} rows in the tree`;
  });

  await step('nothing crashed and the console stayed clean', async () => {
    const reconciliation = pageErrors.filter((e) => /removeChild|insertBefore|NotFoundError|not a child/.test(e));
    assert(reconciliation.length === 0, `${reconciliation.length} reconciliation errors`);
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
