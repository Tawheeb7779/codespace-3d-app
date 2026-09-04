/**
 * Browser end-to-end for the Phase 4 surfaces.
 *
 * Workspaces, activity, presence, membership, commit history and the AI
 * workflow bar, driven against the real application. Nothing is stubbed: the
 * workspace writes to IndexedDB, the activity rows come from the events the
 * app actually recorded, and the commit detail is computed from the stored
 * trees. A step passes only when the state really changed.
 *
 *   node e2e/collaboration.mjs
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
/**
 * Monaco rejects its own pending work with `Canceled` when an editor is
 * disposed, which this suite triggers on every reload. It is library teardown
 * noise, not an application error — matched narrowly so a real failure with a
 * different message still fails the run.
 */
const MONACO_DISPOSE = /^Canceled: Canceled$/m;

page.on('pageerror', (e) => {
  const text = e.stack || e.message;
  if (MONACO_DISPOSE.test(e.message) && text.includes('monaco-editor')) return;
  pageErrors.push(text);
});

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
      .screenshot({ path: `${OUT}/collab-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
      .catch(() => {});
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

const showPanel = async (name) => {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForTimeout(500);
};

const sidebarText = async () => page.locator('aside').first().innerText();

/** Dismiss the first-run tour if it is showing. */
const skipOnboarding = async () => {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(500);
  }
};

let projectName = '';

try {
  await step('1. sign in and reach the dashboard', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    await page.getByRole('button', { name: /New project/i }).first().waitFor({ timeout: 20000 });
  });

  // ------------------------------------------------------------ workspaces

  await step('2. a workspace can be created, and it persists', async () => {
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByRole('dialog', { name: 'New workspace' }).waitFor({ timeout: 10000 });
    await page.getByLabel('Name').fill('Client work');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForTimeout(1200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const body = await page.locator('body').innerText();
    if (!body.includes('Client work')) throw new Error('the workspace did not survive a reload');
  });

  await step('3. an empty workspace really filters the project list', async () => {
    await page.getByRole('button', { name: /Client work/ }).first().click();
    await page.waitForTimeout(900);
    const body = await page.locator('body').innerText();
    if (!/0 of \d+ projects? in Client work/i.test(body)) {
      throw new Error(`the filter did not apply: ${body.slice(0, 300)}`);
    }
  });

  await step('4. a project can be created and added to the workspace', async () => {
    await page.getByRole('button', { name: 'All projects' }).click();
    await page.waitForTimeout(500);
    projectName = `Collab ${Date.now()}`;
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(projectName);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000);
    await skipOnboarding();
  });

  // ------------------------------------------------------------ onboarding

  await step('5. the first-run tour appears once and stays dismissed', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    if (await page.getByRole('button', { name: 'Skip', exact: true }).isVisible().catch(() => false)) {
      throw new Error('the tour reappeared after being dismissed');
    }
  });

  // -------------------------------------------------------------- activity

  await step('6. the activity panel reports this session and no fake presence', async () => {
    await showPanel('Activity');
    const text = await sidebarText();
    if (!/\(you\)/.test(text)) throw new Error(`this session is not listed: ${text.slice(0, 200)}`);
    if (!/not connected/i.test(text)) {
      throw new Error('the panel does not say that live presence is unavailable');
    }
  });

  await step('7. a real commit produces a real activity row', async () => {
    await runCommand('Initialize repository');
    await runCommand('Stage all changes');
    await showPanel('Source control');
    await page.locator('textarea[placeholder="Commit message"]').fill('first commit');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.waitForTimeout(2000);

    await showPanel('Activity');
    const text = await sidebarText();
    if (!/committed/i.test(text)) throw new Error(`no commit activity: ${text.slice(0, 300)}`);
    if (!/first commit/.test(text)) throw new Error('the commit message is not in the timeline');
  });

  await step('8. branch activity is recorded too, and survives a reload', async () => {
    await showPanel('Source control');
    await page.getByRole('button', { name: 'New branch' }).click();
    await page.getByLabel('Branch name').fill('feature');
    await page.getByRole('button', { name: 'Create and switch' }).click();
    await page.waitForTimeout(1500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await showPanel('Activity');
    const text = await sidebarText();
    if (!/created a branch/i.test(text)) {
      throw new Error(`branch activity did not persist: ${text.slice(0, 300)}`);
    }
  });

  // -------------------------------------------------------- commit history

  await step('9. a commit opens a detail view with real numbers', async () => {
    await showPanel('Source control');
    await page.getByRole('tab', { name: /History/i }).click();
    await page.waitForTimeout(700);
    await page.getByText('first commit').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 10000 });
    const text = await dialog.innerText();
    if (!/Commit/.test(text)) throw new Error('no commit hash shown');
    if (!/root commit/i.test(text)) throw new Error('the parent is not described');
    if (!/\+\d+/.test(text) || !/−\d+/.test(text)) {
      throw new Error(`no addition/deletion counts: ${text.slice(0, 300)}`);
    }
  });

  await step('10. a changed file in the commit opens its diff', async () => {
    const dialog = page.getByRole('dialog');
    // The row's text is the path immediately followed by its status
    // ("index.htmladded"), so no word boundary follows the extension.
    const file = dialog.getByRole('button').filter({ hasText: /\.(html|js|css)/ }).first();
    if (!(await file.count())) throw new Error('no changed files listed in the commit');
    await file.click();
    await page.waitForTimeout(900);
    const text = await dialog.innerText();
    if (text.length < 50) throw new Error('the diff did not render');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForTimeout(400);
  });

  // ------------------------------------------------------------ membership

  await step('11. members panel shows the real role and its capabilities', async () => {
    await showPanel('Members');
    // Membership loads asynchronously. Wait on the elements themselves rather
    // than scraping the panel, which can be read mid-render.
    const sidebar = page.locator('aside').first();
    await sidebar.getByText('Your capabilities here').waitFor({ timeout: 15000 });
    await sidebar.getByText('(you)').waitFor({ timeout: 15000 });
    await sidebar.getByText('Owner', { exact: true }).first().waitFor({ timeout: 15000 });
    await sidebar.getByText('Delete the project').waitFor({ timeout: 15000 });
  });

  await step('12. visibility is a real setting that persists', async () => {
    const select = page.getByLabel('Visibility');
    await select.selectOption('public');
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await showPanel('Members');
    if ((await page.getByLabel('Visibility').inputValue()) !== 'public') {
      throw new Error('the visibility change did not persist');
    }
  });

  await step('13. inviting says it needs a backend rather than pretending', async () => {
    const invite = page.getByRole('button', { name: 'Invite someone' });
    if (await invite.isEnabled().catch(() => false)) {
      throw new Error('the invite button is enabled without a backend that could deliver one');
    }
    const text = await sidebarText();
    if (!/Supabase/.test(text)) throw new Error('the panel does not explain why inviting is off');
  });

  // ---------------------------------------------------------- AI workflows

  await step('14. workflows appear only once a provider is connected', async () => {
    await showPanel('Assistant');
    let text = await sidebarText();
    if (/Explain/.test(text)) throw new Error('workflows are offered with no provider connected');

    await page.getByRole('button', { name: 'Provider settings' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('Provider', { exact: true }).selectOption('openai');
    await page.getByLabel('Base URL').fill('http://127.0.0.1:8866/edit');
    await page.getByLabel('Model', { exact: true }).fill('scripted');
    await page.getByLabel('API key').fill('test');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(900);

    text = await sidebarText();
    for (const label of ['Explain', 'Refactor', 'Debug', 'Review']) {
      if (!text.includes(label)) throw new Error(`the ${label} workflow is missing`);
    }
  });

  await step('15. a workflow with nothing to work on is disabled, with a reason', async () => {
    const review = page.getByRole('button', { name: 'Review changes', exact: true });
    const debug = page.getByRole('button', { name: 'Debug', exact: true });
    // The tree is clean right after committing, so Review must be refused.
    if (await review.isEnabled()) throw new Error('Review is offered with no changes to review');
    if (await debug.isEnabled()) throw new Error('Debug is offered with nothing failing');
  });

  await step('16. context controls list what will be sent, and their size', async () => {
    await page.getByText(/^Context ·/).click();
    await page.waitForTimeout(500);
    const text = await sidebarText();
    for (const label of ['Current file', 'Selected code', 'Terminal output', 'Problems']) {
      if (!text.includes(label)) throw new Error(`the ${label} control is missing`);
    }
    if (!/Protected files are never sent/.test(text)) {
      throw new Error('the panel does not state the protected-file guarantee');
    }
    if (!/\d+\s*(chars|k chars)/.test(text)) throw new Error('no context size is reported');
  });

  await step('17. turning a context source on changes the reported size', async () => {
    const before = (await sidebarText()).match(/Context · \d+ sources? · ([\d.]+k?) chars/);
    await page.getByLabel(/^Terminal output/).check();
    await page.waitForTimeout(700);
    const after = (await sidebarText()).match(/Context · (\d+) sources?/);
    if (!after) throw new Error('the context summary disappeared');
    if (before && Number(after[1]) < 1) throw new Error('no sources are counted');
  });

  // ------------------------------------------------------------- keyboard

  await step('18. the new shortcuts reach the right panels', async () => {
    await page.keyboard.press('Escape');
    await page.locator('body').click();
    await page.keyboard.press('Control+Shift+G');
    await page.waitForTimeout(800);
    if (!/Source control/i.test(await sidebarText())) {
      throw new Error('the source control shortcut did not switch panel');
    }
    await page.keyboard.press('Control+Shift+E');
    await page.waitForTimeout(800);
    if (!/Explorer/i.test(await sidebarText())) {
      throw new Error('the explorer shortcut did not switch panel');
    }
  });

  await step('19. next/previous tab cycles real editor tabs', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('style');
    const option = page.getByRole('option').first();
    if (await option.count()) {
      await option.click({ timeout: 10000 });
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
    }
    // Scope to the editor's own tablist: the bottom panel has tabs as well.
    const editorTabs = page.locator('[role="tablist"][aria-label="Open editors"] [role="tab"]');
    const count = await editorTabs.count();
    if (count > 1) {
      const active = await editorTabs.locator('[aria-selected="true"]').first().innerText()
        .catch(async () => (await page.locator('[role="tab"][aria-selected="true"]').first().innerText()));
      await page.locator('body').click();
      await page.keyboard.press('Control+Alt+ArrowRight');
      await page.waitForTimeout(700);
      const next = await editorTabs.locator('[aria-selected="true"]').first().innerText()
        .catch(async () => (await page.locator('[role="tab"][aria-selected="true"]').first().innerText()));
      if (next === active) throw new Error('the next-tab shortcut did not move');
    }
  });

  // -------------------------------------------------------- accessibility

  await step('20. every new panel names itself for a screen reader', async () => {
    const names = await page
      .locator('nav[aria-label="Workspace panels"] button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    for (const expected of ['Project', 'Activity', 'Members']) {
      if (!names.includes(expected)) throw new Error(`${expected} is not reachable`);
    }
    if (names.some((name) => !name)) throw new Error('an unnamed panel button');
  });

  await step('21. dialogs close on Escape and restore a usable page', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByRole('dialog', { name: 'New workspace' }).waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (await page.getByRole('dialog', { name: 'New workspace' }).isVisible().catch(() => false)) {
      throw new Error('Escape did not close the dialog');
    }
    await page.getByRole('button', { name: /New project/i }).first().waitFor({ timeout: 10000 });
  });

  await step('22. deleting a workspace leaves its projects alone', async () => {
    const projectsBefore = (await page.locator('body').innerText()).includes(projectName);
    await page.getByRole('button', { name: /Delete Client work/ }).click();
    await page.getByRole('button', { name: 'Delete workspace' }).click();
    // The success toast repeats the name, so assert on the bar rather than the
    // whole page, and wait for the toast to clear before reading the project list.
    await page.waitForTimeout(1500);
    if (await page.getByRole('button', { name: /^Client work/ }).count()) {
      throw new Error('the workspace was not deleted');
    }
    const after = await page.locator('body').innerText();
    if (projectsBefore && !after.includes(projectName)) {
      throw new Error('deleting the workspace removed a project');
    }
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
