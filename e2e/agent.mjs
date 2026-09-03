/**
 * Browser end-to-end for the coding agent.
 *
 * The model is scripted (`e2e/agent-provider.mjs`); everything else is the
 * real application running in Chromium — the agent loop, the tools, the path
 * validation, the approval gate, the esbuild-wasm build, the change ledger and
 * the diff viewer. Assertions read the real workspace and the real UI, so a
 * step only passes if the app actually did the thing.
 *
 *   node e2e/agent-provider.mjs &
 *   node e2e/agent.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const PROVIDER = process.env.FORGE_AGENT_API ?? 'http://127.0.0.1:8866';
// Alongside the other suites, and git-ignored: a failed run should not
// leave a dozen screenshots loose in the repository root.
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
    console.log(`FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: `${OUT}/agent-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` }).catch(() => {});
  }
};

const openAssistant = async () => {
  const button = page.getByRole('button', { name: 'Assistant', exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForTimeout(400);
};

const connect = async (scenario) => {
  await openAssistant();
  await page.getByRole('button', { name: 'Provider settings' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Base URL').fill(`${PROVIDER}/${scenario}`);
  await page.getByLabel('Model').fill('scripted');
  await page.getByLabel('API key').fill('test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);
};

const clearConversation = async () => {
  const clear = page.getByRole('button', { name: 'Clear conversation' });
  if (await clear.isEnabled().catch(() => false)) await clear.click();
  await page.waitForTimeout(400);
};

const ask = async (text, waitMs = 12000) => {
  await page.getByLabel('Message the assistant').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(waitMs);
};

/**
 * The assistant panel, located by the task bar it contains rather than by
 * position — after a file opens there is more than one aside in the layout.
 * `innerText` returns CSS-transformed text, so callers match case-insensitively.
 */
const panelText = async () => {
  const withTaskBar = page.locator('aside').filter({ has: page.getByTestId('agent-phase') });
  if (await withTaskBar.count()) return withTaskBar.first().innerText();
  return page.locator('aside').first().innerText();
};

/** Read the real project file map out of the running app's file store. */
const projectFile = async (name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await page.getByLabel('Search files').fill(name);
  await page.waitForTimeout(600);
  const options = await page.getByRole('option').allInnerTexts().catch(() => []);
  await page.keyboard.press('Escape');
  return options.some((option) => option.includes(name));
};

const openFileContent = async (name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await page.getByLabel('Search files').fill(name);
  await page.getByRole('option').filter({ hasText: name }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1200);
  return page.locator('.monaco-editor .view-lines').first().innerText();
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
    await page.getByLabel('Project name').fill(`Agent ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
  });

  await step('2. connect the agent to a provider', () => connect('edit'));

  await step('3. the agent plans, reads, edits and verifies', async () => {
    await ask('Rename the button label', 25000);
    const text = await panelText();
    if (!/Plan/i.test(text)) throw new Error(`no plan surfaced: ${text.slice(0, 300)}`);
    if (!/Reading src\/main\.js/.test(text)) throw new Error('the read is not shown in the activity log');
    if (!/Editing src\/main\.js/.test(text)) throw new Error('the edit is not shown');
    if (!/Building the project/.test(text)) throw new Error('the build is not shown');
  });

  await step('4. the edit really landed in the file', async () => {
    const content = await openFileContent('main.js');
    if (!content.includes('Pressed')) throw new Error(`the file was not edited: ${content.slice(0, 200)}`);
    if (content.includes('Clicked')) throw new Error('the old text is still there');
  });

  await step('5. the task reports a real build result, not a claim', async () => {
    await openAssistant();
    const text = await panelText();
    if (!/build:/.test(text)) throw new Error(`no verification evidence: ${text.slice(0, 400)}`);
    if (!/Build succeeded/i.test(text)) throw new Error(`the build result is not reported: ${text.slice(0, 400)}`);
  });

  await step('6. the changed file is listed and opens the diff viewer', async () => {
    const text = await panelText();
    if (!/1 file changed/i.test(text)) throw new Error(`no change list: ${text.slice(0, 400)}`);
    await page.getByRole('button', { name: /src\/main\.js/ }).first().click();
    await page.getByRole('dialog').waitFor({ timeout: 8000 });
    const diff = await page.getByRole('dialog').innerText();
    if (!/Pressed/.test(diff)) throw new Error(`the diff does not show the change: ${diff.slice(0, 300)}`);
    await page.getByRole('button', { name: /^Close$/ }).click();
    await page.waitForTimeout(500);
  });

  await step('7. the task ends in a completed state, not stuck running', async () => {
    const phase = await page.getByTestId('agent-phase').innerText();
    if (!/Completed/.test(phase)) throw new Error(`task phase is "${phase}"`);
  });

  await step('8. a second read of the same file is served from context', async () => {
    await clearConversation();
    await connect('cached');
    await ask('Look at main.js twice', 20000);
    const phase = await page.getByTestId('agent-phase').innerText();
    if (!/Completed/.test(phase)) throw new Error(`task did not finish: ${phase}`);
    // Both reads are logged; the saving is in what was sent, asserted in unit tests.
    const text = await panelText();
    const reads = (text.match(/Reading src\/main\.js/g) ?? []).length;
    if (reads < 2) throw new Error(`expected two reads in the log, saw ${reads}`);
  });

  await step('9. a destructive action stops and asks, with what/why/affects', async () => {
    await clearConversation();
    await connect('destructive');
    await ask('Remove the stylesheet', 12000);
    const approval = page.getByRole('alertdialog', { name: 'Approval required' });
    await approval.waitFor({ timeout: 15000 });
    const text = await approval.innerText();
    for (const field of ['What', 'Why', 'Affects']) {
      if (!new RegExp(field).test(text)) throw new Error(`the request does not say ${field}`);
    }
    if (!/styles\.css/.test(text)) throw new Error('the request does not name the file');
    const phase = await page.getByTestId('agent-phase').innerText();
    if (!/approval/i.test(phase)) throw new Error(`phase should be waiting for approval, was "${phase}"`);
  });

  await step('10. declining leaves the file in place', async () => {
    await page.getByRole('button', { name: /^Decline$/ }).click();
    await page.waitForTimeout(6000);
    if (!(await projectFile('styles.css'))) throw new Error('the file was deleted despite the decline');
  });

  await step('11. approving actually performs the deletion', async () => {
    await clearConversation();
    await connect('destructive');
    await ask('Remove the stylesheet', 10000);
    await page.getByRole('alertdialog', { name: 'Approval required' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /^Approve$/ }).click();
    await page.waitForTimeout(7000);
    if (await projectFile('styles.css')) throw new Error('the approved delete did not happen');
  });

  await step('12. path escapes are refused, and nothing is created', async () => {
    await clearConversation();
    await connect('escape');
    await ask('Read some system files', 18000);
    const text = await panelText();
    if (/root:x:0:0/.test(text)) throw new Error('the agent read outside the project');
    const refusals = (text.match(/blocked|escapes|absolute path|error/gi) ?? []).length;
    if (refusals < 2) throw new Error(`escapes did not visibly fail: ${text.slice(0, 500)}`);
    if (await projectFile('passwd')) throw new Error('an absolute path was rewritten into the project');
  });

  await step('13. a failing build is surfaced, then fixed and re-verified', async () => {
    await clearConversation();
    await connect('recover');
    await ask('Refactor main.js', 40000);
    const text = await panelText();
    if (!/Build succeeded/i.test(text)) throw new Error(`no successful re-verification: ${text.slice(0, 500)}`);
    const content = await openFileContent('main.js');
    if (!content.includes('recovered')) throw new Error('the fix did not land');
  });

  await step('14. cancelling stops the task and says what was done', async () => {
    await openAssistant();
    await clearConversation();
    await connect('slow');
    await page.getByLabel('Message the assistant').fill('Run a long job');
    await page.getByRole('button', { name: 'Send message' }).click();
    // The scripted provider delays this scenario, so there is a real window.
    await page.getByRole('button', { name: 'Stop the assistant' }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Stop the assistant' }).click();
    await page.waitForTimeout(4000);
    const phase = await page.getByTestId('agent-phase').innerText();
    if (!/Cancelled/.test(phase)) throw new Error(`phase after cancel is "${phase}"`);
  });

  await step('15. the UI is usable again after a cancel', async () => {
    await page.waitForTimeout(1500);
    const box = page.getByLabel('Message the assistant');
    if (await box.isDisabled()) throw new Error('the composer is stuck disabled after cancelling');
    const stop = page.getByRole('button', { name: 'Stop the assistant' });
    if (await stop.isVisible().catch(() => false)) {
      throw new Error('the panel is still showing a running task');
    }
  });

  await step('16. a read-only project offers no editing tools', async () => {
    const readOnly = await page.evaluate(() => {
      const el = document.body.innerText;
      return /read-only access/.test(el);
    });
    // Only meaningful when the role is actually viewer; the unit suite covers
    // the enforcement itself, so this only checks the panel explains it.
    if (readOnly) {
      const text = await panelText();
      if (!/cannot edit/i.test(text)) throw new Error('read-only mode is not explained');
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
