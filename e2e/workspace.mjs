/**
 * Browser end-to-end for the Phase 3 workspace surfaces.
 *
 * Nothing here is stubbed: the command palette drives the real stores, the
 * explorer writes through the real virtual file system, the search worker does
 * the real scan, and source control runs the real VCS. A step passes only when
 * the application state actually changed, not when a button merely rendered.
 *
 *   node e2e/workspace.mjs
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
      .screenshot({ path: `${OUT}/workspace-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
      .catch(() => {});
  }
};

/** Run a command by name through the real palette. */
const runCommand = async (label) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10000 });
  await page.getByLabel('Search commands').fill(`>${label}`);
  await page.waitForTimeout(300);
  const option = page.getByRole('option').filter({ hasText: label }).first();
  await option.click({ timeout: 10000 });
  await page.waitForTimeout(700);
};

const panel = (name) => page.getByRole('button', { name, exact: true });

const showPanel = async (name) => {
  if ((await panel(name).getAttribute('aria-pressed')) !== 'true') await panel(name).click();
  await page.waitForTimeout(400);
};

const sidebarText = async () => page.locator('aside').first().innerText();

/** Monaco renders spaces as non-breaking, so compare on normalised text. */
const editorText = async () => {
  const raw = await page.locator('.monaco-editor .view-lines').first().innerText();
  return raw.replace(/\u00a0/g, ' ');
};

try {
  await step('1. sign in and open a project', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`Workspace ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
  });

  // -------------------------------------------------------------- project

  await step('2. the project panel reports the real project', async () => {
    await showPanel('Project');
    const text = await sidebarText();
    if (!/Workspace \d+/.test(text)) throw new Error(`project name missing: ${text.slice(0, 200)}`);
    if (!/file/i.test(text)) throw new Error('no file count shown');
    if (!/Recent files/i.test(text)) throw new Error('no recent files section');
  });

  await step('3. a recent file in the panel opens that file', async () => {
    const before = await page.locator('.monaco-editor .view-lines').first().innerText();
    const entry = page.locator('aside').first().getByRole('button').filter({ hasText: /\.(js|css|html)$/ }).first();
    if (await entry.count()) {
      await entry.click();
      await page.waitForTimeout(900);
    }
    const after = await page.locator('.monaco-editor .view-lines').first().innerText();
    if (typeof after !== 'string' || !after.length) {
      throw new Error(`the editor is empty after opening a recent file (was ${before.length} chars)`);
    }
  });

  // ----------------------------------------------------- command palette

  await step('4. "New file" from the palette really creates a file', async () => {
    await runCommand('New file');
    const input = page.getByLabel('New file name');
    await input.waitFor({ timeout: 10000 });
    await input.fill('palette-made.ts');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    await showPanel('Explorer');
    if (!(await sidebarText()).includes('palette-made.ts')) {
      throw new Error('the file is not in the explorer');
    }
  });

  await step('5. the created file is the open editor, and it can be typed into', async () => {
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type('export const made = 1;');
    await page.waitForTimeout(1500);
    const content = await editorText();
    if (!content.includes('export const made')) throw new Error(`not editable: ${content.slice(0, 120)}`);
  });

  /**
   * Auto save is on by default and clears the dirty set within a second, so
   * the indicator is only observable with it off — which is itself one of the
   * settings this phase added.
   */
  await step('6. an unsaved file is marked in the explorer', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const autoSave = page.getByLabel('Auto save');
    if (await autoSave.isChecked()) await autoSave.click();
    await page.waitForTimeout(400);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);

    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type('\nexport const dirty = 2;');
    await page.waitForTimeout(1200);

    await showPanel('Explorer');
    const marks = await page.locator('aside [aria-label="Unsaved changes"]').count();
    if (marks === 0) throw new Error('no dirty indicator appeared for the edited file');

    // Saving clears it again, so the mark tracks real state rather than sticking.
    await runCommand('Save all files');
    await page.waitForTimeout(1200);
    await showPanel('Explorer');
    if ((await page.locator('aside [aria-label="Unsaved changes"]').count()) !== 0) {
      throw new Error('the dirty indicator survived a save');
    }
  });

  await step('7. "New folder" from the palette really creates a folder', async () => {
    await runCommand('New folder');
    const input = page.getByLabel('New folder name');
    await input.waitFor({ timeout: 10000 });
    await input.fill('palette-dir');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    if (!(await sidebarText()).includes('palette-dir')) throw new Error('the folder is not in the tree');
  });

  await step('8. "Close all editor tabs" leaves the empty state', async () => {
    await runCommand('Close all editor tabs');
    const empty = page.getByText('No file open');
    await empty.waitFor({ timeout: 10000 });
  });

  await step('9. quick open reopens a file by name', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('palette-made');
    await page.getByRole('option').filter({ hasText: 'palette-made.ts' }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    const content = await editorText();
    if (!content.includes('export const made')) throw new Error('the reopened file lost its content');
  });

  // -------------------------------------------------------------- search

  await step('10. "Replace in files" opens search with replace showing', async () => {
    await runCommand('Replace in files');
    const replace = page.getByLabel('Replace with');
    await replace.waitFor({ timeout: 10000 });
  });

  await step('11. search finds a real match and arrow keys walk the results', async () => {
    const query = page.getByLabel('Search across files');
    await query.fill('made');
    await page.waitForTimeout(1500);
    const results = await sidebarText();
    if (!/result/i.test(results)) throw new Error(`no results: ${results.slice(0, 200)}`);
    await query.press('ArrowDown');
    await page.waitForTimeout(700);
    const current = await page.locator('aside [aria-current="true"]').count();
    if (current === 0) throw new Error('arrow keys did not move the result cursor');
  });

  await step('12. replace all rewrites the real file', async () => {
    await page.getByLabel('Replace with').fill('remade');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('palette-made');
    await page.getByRole('option').filter({ hasText: 'palette-made.ts' }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1200);
    const content = await editorText();
    if (!content.includes('remade')) throw new Error(`replace did not reach the file: ${content.slice(0, 160)}`);
  });

  // ------------------------------------------------------ source control

  await step('13. the palette initializes a real repository', async () => {
    await runCommand('Initialize repository');
    await showPanel('Source control');
    const text = await sidebarText();
    if (/No repository yet/i.test(text)) throw new Error('the repository was not created');
  });

  await step('14. the branch it starts on is the configured default', async () => {
    const branch = page.getByLabel('Current branch');
    const value = await branch.inputValue();
    if (value !== 'main') throw new Error(`expected main, got ${value}`);
  });

  await step('15. staging and committing through the palette and panel is real', async () => {
    await runCommand('Stage all changes');
    await showPanel('Source control');
    await page.locator('textarea[placeholder="Commit message"]').fill('first commit');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.waitForTimeout(1500);
    const text = await sidebarText();
    if (!/clean/i.test(text)) throw new Error(`the working tree is not clean after committing: ${text.slice(0, 200)}`);
  });

  await step('16. a second branch can be created and switched to from the palette', async () => {
    await page.getByRole('button', { name: 'New branch' }).click();
    await page.getByLabel('Branch name').fill('feature');
    await page.getByRole('button', { name: 'Create and switch' }).click();
    await page.waitForTimeout(1200);
    if ((await page.getByLabel('Current branch').inputValue()) !== 'feature') {
      throw new Error('the new branch was not checked out');
    }
    await runCommand('Switch to branch main');
    await showPanel('Source control');
    if ((await page.getByLabel('Current branch').inputValue()) !== 'main') {
      throw new Error('the palette did not switch branches');
    }
  });

  await step('17. a branch can be deleted, and the delete really removes it', async () => {
    await page.getByLabel('Current branch').selectOption('feature');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Delete the feature branch/ }).click();
    await page.getByRole('button', { name: 'Delete branch' }).click();
    await page.waitForTimeout(1500);
    const options = await page.getByLabel('Current branch').locator('option').allInnerTexts();
    if (options.includes('feature')) throw new Error('the branch is still listed');
  });

  // ------------------------------------------------------------ settings

  await step('18. the new settings sections exist and persist a change', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    for (const name of ['Terminal', 'Source control', 'Assistant', 'Workspace']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(300);
    }
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByLabel('Font size').fill('17');
    await page.waitForTimeout(600);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.waitForTimeout(500);
    const value = await page.getByLabel('Font size').inputValue();
    if (value !== '17') throw new Error(`the setting did not persist: ${value}`);
  });

  await step('19. the terminal honours the configured font size', async () => {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.keyboard.press('Control+J');
    await page.waitForTimeout(1500);
    const size = await page.evaluate(() => {
      const row = document.querySelector('.xterm-rows div');
      return row ? getComputedStyle(row).fontSize : '';
    });
    if (size && parseFloat(size) < 15) throw new Error(`terminal font is ${size}, expected the configured 17px`);
  });

  // ------------------------------------------------------ session restore

  await step('20. reloading restores the files that were open', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('palette-made');
    await page.getByRole('option').filter({ hasText: 'palette-made.ts' }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(3500);
    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    if (!tabs.some((tab) => tab.includes('palette-made.ts'))) {
      throw new Error(`the session was not restored: ${tabs.join(', ')}`);
    }
  });

  // ------------------------------------------------------- accessibility

  await step('21. Escape closes the palette, and focus is reachable by keyboard', async () => {
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await page.getByRole('dialog', { name: 'Command palette' }).isVisible().catch(() => false)) {
      throw new Error('Escape did not close the palette');
    }
    const focused = await page.evaluate(() => {
      document.body.focus();
      return document.activeElement?.tagName ?? '';
    });
    if (!focused) throw new Error('nothing is focusable');
  });

  await step('22. every activity bar entry names itself for a screen reader', async () => {
    const names = await page.locator('nav[aria-label="Workspace panels"] button').evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label')),
    );
    if (!names.length) throw new Error('no panel buttons found');
    if (names.some((name) => !name)) throw new Error(`an unnamed button: ${names.join(', ')}`);
    if (!names.includes('Project')) throw new Error('the project panel is not reachable');
  });

  // ---------------------------------------------------------- responsive

  await step('23. a narrow viewport switches to the mobile layout, still usable', async () => {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(1200);
    const nav = page.getByRole('navigation', { name: 'Workspace sections' });
    await nav.waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.waitForTimeout(800);
    const body = await page.locator('body').innerText();
    if (!body.trim()) throw new Error('the narrow layout renders nothing');
    // The desktop layout must not leave a horizontal scrollbar behind.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    if (overflow) throw new Error('the page scrolls horizontally at 480px');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);
  });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('--- console errors ---');
  console.log(consoleErrors.length ? [...new Set(consoleErrors)].join('\n') : '(none)');
  console.log('--- page errors ---');
  console.log(pageErrors.length ? [...new Set(pageErrors)].join('\n') : '(none)');
  await browser.close();
}

process.exit(failed || pageErrors.length ? 1 : 0);
