/**
 * The features added in the platform pass, driven in a browser.
 *
 * Each of these is a new way into something that already existed — the
 * assistant's workflows, the panel geometry, the keymap, the toast stream, the
 * terminal sessions. The risk with that kind of change is not that the feature
 * is wrong but that the entry point does not reach it, which only a real
 * browser can settle.
 *
 *   node e2e/platform.mjs
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
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
    await page.screenshot({ path: `${OUT}/platform-fail-${name.replace(/\W+/g, '-').slice(0, 50)}.png` }).catch(() => {});
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
const runCommand = async (label) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10000 });
  await page.getByLabel('Search commands').fill(`>${label}`);
  await page.waitForTimeout(300);
  await page.getByRole('option').filter({ hasText: label }).first().click({ timeout: 10000 });
  await page.waitForTimeout(700);
};
/** The layout the store is actually holding, rather than what the screen suggests. */
const layoutState = () =>
  page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (value?.state && 'sidebarOpen' in value.state) return value.state;
      } catch {
        /* not ours */
      }
    }
    return null;
  });
/**
 * Open the bottom panel, whatever it was doing before.
 *
 * "Toggle terminal" is a toggle, and the layout presets earlier in this file
 * leave it open or closed depending on which one ran last — so calling the
 * command blind is a coin flip that closes the panel half the time.
 */
const ensureBottomPanel = async () => {
  if ((await layoutState())?.bottomOpen) return;
  await runCommand('Toggle terminal');
  await page.waitForTimeout(600);
};

try {
  await step('sign in and open a project', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`Platform ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2000);
  });

  // ------------------------------------------------------------- layouts

  await step('a layout preset rearranges the panels', async () => {
    await runCommand('Layout: Source control');
    const state = await layoutState();
    assert(state?.sidebarPanel === 'git', `sidebar is on ${state?.sidebarPanel}`);
    assert(state?.previewOpen === false, 'the preview should be closed in this layout');
    assert(state?.layout === 'git', `layout is ${state?.layout}`);
    return 'source control layout applied';
  });

  await step('a preset leaves the sizes the user set alone', async () => {
    const handle = page.getByRole('separator', { name: /resize sidebar/i }).first();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + i * 10, box.y + box.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const width = (await layoutState())?.sidebarWidth;

    await runCommand('Layout: Assistant');
    const after = await layoutState();
    assert(after?.sidebarWidth === width, `width changed: ${width} -> ${after?.sidebarWidth}`);
    assert(after?.sidebarPanel === 'assistant', `sidebar is on ${after?.sidebarPanel}`);
    return `sidebar held at ${width}px`;
  });

  await step('focus mode clears the workspace and gives it back', async () => {
    await runCommand('Layout: Coding');
    const before = await layoutState();

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForTimeout(700);
    const focused = await layoutState();
    assert(focused?.layout === 'focus', `layout is ${focused?.layout}`);
    assert(focused?.sidebarOpen === false, 'the sidebar is still open in focus mode');
    assert(focused?.bottomOpen === false, 'the bottom panel is still open in focus mode');
    // The editor must survive, or focus mode is just a blank screen.
    assert(await page.locator('.monaco-editor').first().isVisible(), 'no editor in focus mode');

    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForTimeout(700);
    const restored = await layoutState();
    assert(restored?.layout === null, `layout is ${restored?.layout}`);
    assert(
      restored?.sidebarOpen === before?.sidebarOpen && restored?.bottomOpen === before?.bottomOpen,
      'leaving focus mode did not restore what it replaced',
    );
    return 'entered and left, panels restored';
  });

  // ---------------------------------------------------------- shortcuts

  await step('the shortcut overlay lists the real keymap and can be searched', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await dialog.waitFor({ timeout: 8000 });

    const all = await dialog.innerText();
    assert(/Command palette/.test(all), 'the palette binding is not listed');
    assert(/Focus mode/.test(all), 'the focus binding is not listed');

    await page.getByLabel('Find a shortcut').fill('terminal');
    await page.waitForTimeout(300);
    const filtered = await dialog.innerText();
    assert(/bottom panel/i.test(filtered), 'searching for terminal found nothing');
    assert(!/Command palette/.test(filtered), 'the filter did not narrow anything');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return 'listed and filtered';
  });

  // ------------------------------------------------------- notifications

  await step('notifications are kept after their toast has gone', async () => {
    // Saving raises a real notification path; use a git action, which reports
    // either way, so this does not depend on a save failing.
    await runCommand('Initialize repository');
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: /^Notifications/ }).click({ timeout: 8000 });
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await dialog.waitFor({ timeout: 8000 });
    const text = await dialog.innerText();
    assert(
      !/Nothing to catch up on/.test(text),
      'the centre is empty even though something was announced',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return text.split('\n')[1] ?? 'recorded';
  });

  // ------------------------------------------------------------ inline AI

  await step('the editor offers the assistant on a selection', async () => {
    await runCommand('Layout: Coding');
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(300);

    // Monaco's own command palette is the reliable way to see whether an
    // action is registered and enabled for the current selection.
    await page.keyboard.press('F1');
    await page.waitForTimeout(600);
    const quickInput = page.locator('.quick-input-widget');
    await quickInput.waitFor({ timeout: 8000 });
    await page.keyboard.type('TA AI');
    await page.waitForTimeout(600);
    const listed = await quickInput.innerText();
    assert(/TA AI: Explain/.test(listed), `the workflows are not in the editor: ${listed.slice(0, 120)}`);
    assert(/TA AI: Ask about this selection/.test(listed), 'the ask action is missing');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return 'workflows registered as editor actions';
  });

  await step('asking about a selection opens the assistant with it', async () => {
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+a');
    // Control+Alt+I, not Control+Shift+I: the latter is "format document" in
    // the app keymap and the global dispatcher takes it before Monaco.
    await page.keyboard.press('Control+Alt+I');
    await page.waitForTimeout(900);

    const state = await layoutState();
    assert(state?.sidebarPanel === 'assistant', `sidebar is on ${state?.sidebarPanel}`);
    // The panel must actually be showing, not merely selected behind a closed
    // sidebar — the answer would arrive somewhere nobody is looking.
    assert(state?.sidebarOpen === true, 'the assistant panel is not open');
    return 'assistant opened with the selection';
  });

  // -------------------------------------------------------------- terminal

  await step('a terminal session can be renamed', async () => {
    await ensureBottomPanel();
    await page.waitForTimeout(800);
    // Terminal tabs are named for the environment they run in — "project",
    // "project·linux", "linux" — rather than "shell", so that which machine a
    // command lands on is visible on the tab itself. The behaviour under test
    // is the rename, which is unchanged; only the tab's name has.
    const tab = page.getByRole('button', { name: /Project Terminal: project/i }).first();
    await tab.dblclick({ timeout: 8000 });
    const input = page.getByLabel('Terminal name');
    await input.waitFor({ timeout: 8000 });
    await input.fill('build watch');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    assert(
      await page.getByText('build watch').first().isVisible(),
      'the renamed session is not showing',
    );
    return 'renamed to "build watch"';
  });

  await step('terminal output can be copied', async () => {
    await ensureBottomPanel();
    await page.getByRole('button', { name: /Copy terminal output/i }).click({ timeout: 8000 });
    await page.waitForTimeout(900);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    assert(copied.length > 0, 'nothing reached the clipboard');
    assert(/TA CODE shell/.test(copied), `the transcript looks wrong: ${copied.slice(0, 80)}`);
    return `${copied.split('\n').length} lines`;
  });

  // ------------------------------------------------------------- settings

  await step('settings can be searched by what a setting does', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const box = page.getByLabel('Search settings');
    await box.fill('word wrap');
    await page.waitForTimeout(400);

    const nav = page.locator('nav[aria-label="Settings sections"]');
    const sections = await nav.innerText();
    assert(/Editor/.test(sections), 'searching for "word wrap" lost the Editor section');
    assert(!/Account/.test(sections), 'the filter did not narrow the list');
    // And the body followed the filter rather than staying on a hidden section.
    assert(
      await page.getByText('Word wrap').first().isVisible(),
      'the setting that was searched for is not on screen',
    );
    return 'narrowed to Editor';
  });

  await step('nothing crashed and the console stayed clean', async () => {
    const reconciliation = pageErrors.filter((e) => /removeChild|insertBefore|NotFoundError/.test(e));
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
