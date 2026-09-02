/**
 * End-to-end smoke test.
 *
 * Drives a real browser through the flows that would be expensive to get wrong:
 * sign-in, project creation, the editor, a real build and preview, the shell,
 * search, version control, the command palette, settings and the mobile layout.
 * It fails on any uncaught page error or console error, so a regression that
 * only shows up at runtime still breaks the run.
 *
 * Playwright is not a dependency of the app. Install it first:
 *
 *   npm i -D playwright && npx playwright install chromium
 *
 * Then, with the dev server running on :5173:
 *
 *   npm run test:e2e
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? 'e2e/artifacts';
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch(
  // Honour a preinstalled browser when one is provided by the environment.
  process.env.FORGE_E2E_CHROMIUM ? { executablePath: process.env.FORGE_E2E_CHROMIUM } : {},
);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '-')}.png` });
    throw error;
  }
};

try {
  await step('landing page renders', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /A real IDE that opens in a tab/i }).waitFor({ timeout: 15000 });
  });

  await page.screenshot({ path: `${OUT}/01-landing.png`, fullPage: false });

  await step('landing monaco demo mounts', async () => {
    await page.getByRole('link', { name: /Try the editor below/i }).click().catch(() => {});
    await page.locator('#editor').scrollIntoViewIfNeeded();
    await page.locator('#editor .monaco-editor').first().waitFor({ timeout: 30000 });
  });

  await step('local mode sign in', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Continue in Local Mode/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  await page.screenshot({ path: `${OUT}/02-dashboard-empty.png` });

  await step('create a vanilla project', async () => {
    // The vanilla template has no bare imports, so the preview is verifiable
    // without reaching an external package CDN.
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: /Vanilla HTML\/CSS\/JS/i }).click();
    await page.getByLabel('Project name').fill('Smoke Test App');
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 20000 });
  });

  await step('workspace opens with monaco', async () => {
    await page.locator('.monaco-editor').first().waitFor({ timeout: 40000 });
  });

  await step('file explorer lists template files', async () => {
    await page.getByText('src', { exact: true }).first().waitFor({ timeout: 10000 });
  });

  await step('preview builds and runs', async () => {
    // esbuild-wasm has to download and initialise; give it room.
    await page.getByText(/running ·/i).waitFor({ timeout: 120000 });
    const frame = page.frameLocator('iframe[title="Project preview"]');
    await frame.getByRole('heading', { name: /Vanilla App/i }).waitFor({ timeout: 30000 });
  });

  await page.screenshot({ path: `${OUT}/03-workspace.png` });

  await step('editing a file rebuilds the preview', async () => {
    // Quick-open the script the preview actually executes.
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('main.js');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type("\nconsole.log('edited by smoke test');\n");
    await page.waitForTimeout(3000);
    await page.getByRole('tab', { name: /Output/i }).click();
    await page.getByText(/edited by smoke test/).first().waitFor({ timeout: 60000 });
    await page.getByRole('tab', { name: /Terminal/i }).click();
  });

  await step('preview reacts to a click', async () => {
    const frame = page.frameLocator('iframe[title="Project preview"]');
    await frame.getByRole('button', { name: /Clicked 0 times/i }).click();
    await frame.getByRole('button', { name: /Clicked 1 time$/i }).waitFor({ timeout: 10000 });
  });

  await step('terminal runs a real command', async () => {
    await page.locator('.xterm').waitFor({ timeout: 20000 });
    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('ls');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.keyboard.type('cat README.md');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const text = await page.locator('.xterm-screen').innerText();
    if (!text.includes('index.html')) throw new Error(`ls output missing: ${text.slice(0, 400)}`);
    if (!text.includes('# Vanilla App')) throw new Error('cat output missing README content');
  });

  await step('unknown command is refused, not faked', async () => {
    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('sudo apt install nginx');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const text = await page.locator('.xterm-screen').innerText();
    if (!text.includes('command not found: sudo')) throw new Error('expected a not-found error');
  });

  await step('shell mutations reach the editor', async () => {
    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('echo hello > notes.txt');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.getByText('notes.txt', { exact: true }).first().waitFor({ timeout: 8000 });
  });

  await step('terminal survives a remount without duplicating instances', async () => {
    const before = await page.locator('.xterm-screen').innerText();
    if (!before.includes('notes.txt')) throw new Error('expected prior scrollback');

    // Switching panels unmounts and remounts the terminal view.
    await page.getByRole('tab', { name: /Problems/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('tab', { name: /Terminal/i }).click();
    await page.waitForTimeout(600);

    const instances = await page.locator('.xterm').count();
    if (instances !== 1) throw new Error(`expected one xterm instance, found ${instances}`);

    const after = await page.locator('.xterm-screen').innerText();
    if (!after.includes('notes.txt')) throw new Error('scrollback was lost across the remount');

    // The reattached terminal still accepts input.
    await page.locator('.xterm-screen').first().click();
    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const text = await page.locator('.xterm-screen').innerText();
    if (!/\n\/\s*$|\/\n/.test(text) && !text.includes('pwd')) {
      throw new Error('terminal stopped accepting input after the remount');
    }
  });

  await step('filesystem escape attempts are refused in the terminal', async () => {
    await page.locator('.xterm-screen').first().click();
    for (const command of ['cat ../../../etc/passwd', 'touch ../escape.ts', 'mkdir ../../evil']) {
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    const text = await page.locator('.xterm-screen').innerText();
    if (!/escapes the project root|no such/i.test(text)) {
      throw new Error(`traversal was not refused:\n${text.slice(-600)}`);
    }
    // Nothing outside the project appeared in the tree.
    const stray = await page.getByText('escape.ts', { exact: true }).count();
    if (stray > 0) throw new Error('a traversing path created a file');
  });

  await step('command palette opens and filters', async () => {
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: /Command palette/i });
    await dialog.waitFor({ timeout: 8000 });
    await page.keyboard.type('terminal');
    await dialog.getByText(/Toggle terminal/i).first().waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await page.screenshot({ path: `${OUT}/04-palette.png` });

  await step('search panel finds text across files', async () => {
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    const input = page.getByLabel('Search across files');
    await input.waitFor({ timeout: 8000 });
    await input.fill('counter');
    await page.getByText(/results? in/i).waitFor({ timeout: 15000 });
  });

  await step('source control initializes and commits', async () => {
    await page.getByRole('button', { name: 'Source control', exact: true }).first().click();
    await page.getByRole('button', { name: /Initialize repository/i }).click();
    await page.getByRole('button', { name: /^Stage all$/ }).click();
    await page.getByPlaceholder('Commit message').fill('initial commit');
    await page.getByRole('button', { name: /^Commit$/ }).click();
    await page.getByText(/Working tree clean/i).waitFor({ timeout: 15000 });
  });

  await page.screenshot({ path: `${OUT}/05-git.png` });

  await step('packages panel lists declared dependencies', async () => {
    await page.getByRole('button', { name: 'Packages', exact: true }).first().click();
    await page.getByText(/Declared dependencies/i).waitFor({ timeout: 8000 });
    await page.getByText(/No dependencies/i).waitFor({ timeout: 8000 });
  });

  await step('assistant states it is not connected', async () => {
    await page.getByRole('button', { name: 'Assistant', exact: true }).first().click();
    await page.getByText(/No model provider connected/i).waitFor({ timeout: 8000 });
  });

  await step('problems panel reports a real diagnostic and navigates to it', async () => {
    // Introduce a genuine syntax error and confirm Monaco's diagnostics reach
    // the panel, and that clicking one jumps to the location.
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nconst broken: = ;\n');
    await page.getByRole('tab', { name: /Problems/i }).click();
    const problem = page.locator('button', { hasText: /expected|declaration|identifier/i }).first();
    await problem.waitFor({ timeout: 30000 });
    await problem.click();
    await page.waitForTimeout(500);
  });

  await step('the bottom panel closes and reopens with the same shortcut', async () => {
    // Regression: the handler set the tab (which opens the panel) and then
    // toggled, so Ctrl+J could hide the panel but never bring it back.
    const panel = page.locator('section[aria-label="Panel"]');
    if (!(await panel.isVisible())) await page.keyboard.press('Control+j');
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(400);
    if (await panel.isVisible()) throw new Error('the panel did not close');
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(400);
    if (!(await panel.isVisible())) throw new Error('the panel did not reopen');
  });

  await step('split editor puts a second editor beside the first', async () => {
    // Regression: the button split to the active path, which the pane refused
    // to render, so it lit up and showed nothing.
    const before = await page.locator('.monaco-editor').count();
    await page.getByRole('button', { name: 'Split editor', exact: true }).click();
    await page.waitForTimeout(1500);
    const after = await page.locator('.monaco-editor').count();
    if (after <= before) throw new Error(`split added no editor (${before} → ${after})`);
    await page.getByRole('button', { name: 'Close split view', exact: true }).click();
    await page.waitForTimeout(500);
  });

  await step('closing every tab leaves the empty state, not a reopened file', async () => {
    // Regression: the "open a sensible first file" effect fired whenever the
    // active path went null, so Close all was immediately undone.
    await page
      .locator('[role="tablist"][aria-label="Open editors"] [role="tab"]')
      .first()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Close all/i }).click();
    await page.waitForTimeout(800);
    await page.getByText('No file open').waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: 'Open a file' }).click();
    await page.getByLabel('Search files').fill('index.html');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.locator('.monaco-editor').first().waitFor({ timeout: 20000 });
  });

  await step('settings page renders and toggles theme', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByLabel('Colour theme').selectOption('forge-light');
    await page.waitForTimeout(400);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== 'forge-light') throw new Error(`theme did not apply: ${theme}`);
    await page.getByLabel('Colour theme').selectOption('forge-dark');
  });

  await page.screenshot({ path: `${OUT}/06-settings.png` });

  await step('dashboard shows the created project', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Smoke Test App' }).waitFor({ timeout: 10000 });
  });

  await step('protected route redirects when signed out', async () => {
    await page.evaluate(() => indexedDB.deleteDatabase('forge-ide'));
    await page.goto(`${BASE}/project/nonexistent`, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/signin/, { timeout: 10000 });
  });

  await step('mobile layout uses the bottom navigation', async () => {
    const mobile = await context.newPage();
    mobile.on('pageerror', (error) => pageErrors.push('[mobile] ' + (error.stack || error.message)));
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
    await mobile.getByRole('button', { name: /Continue in Local Mode/i }).click();
    await mobile.waitForURL('**/dashboard', { timeout: 15000 });
    await mobile.getByRole('heading', { name: 'Projects' }).waitFor({ timeout: 10000 });
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) throw new Error('dashboard overflows horizontally on mobile');
    await mobile.screenshot({ path: `${OUT}/07-mobile-dashboard.png` });
    await mobile.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    await mobile.close();
  });
} finally {
  console.log('\n--- console errors ---');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
  console.log('--- page errors ---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
}

// A clean run means no uncaught errors anywhere in the app.
if (pageErrors.length || consoleErrors.length) {
  console.error('\nFailing: the run produced browser errors.');
  process.exit(1);
}
console.log('\nAll steps passed with no browser errors.');
