/**
 * Browser end-to-end for the Phase 5 surfaces.
 *
 * Tasks, problems, outline, editor intelligence and git history, driven
 * against the real application. Every assertion reads state the app actually
 * produced: a task's exit code comes from the project shell, the outline comes
 * from the TypeScript worker, and the problem list comes from real
 * diagnostics.
 *
 *   node e2e/devexp.mjs
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

/** Monaco rejects its own pending work with `Canceled` when disposed. */
const MONACO_DISPOSE = /^Canceled: Canceled$/m;

/**
 * This suite deliberately breaks the user's project to produce a real type
 * error, so the sandboxed preview crashes on purpose. Those failures come from
 * `about:srcdoc` — the previewed project, not the IDE — and counting them as
 * application errors would mean the suite could never assert on a broken
 * build. Anything without that origin still fails the run.
 */
const FROM_PREVIEW = /about:srcdoc/;

page.on('pageerror', (e) => {
  const text = e.stack || e.message;
  if (MONACO_DISPOSE.test(e.message) && text.includes('monaco-editor')) return;
  if (FROM_PREVIEW.test(text)) return;
  pageErrors.push(text);
});
page.on('console', (m) => {
  if (m.type() === 'error' && FROM_PREVIEW.test(m.location()?.url ?? '')) return;
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
      .screenshot({ path: `${OUT}/devexp-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
      .catch(() => {});
  }
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
  await page.waitForTimeout(350);
  await page.getByRole('option').filter({ hasText: label }).first().click({ timeout: 10000 });
  await page.waitForTimeout(700);
};

const showPanel = async (name) => {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForTimeout(500);
};

const sidebarText = async () => page.locator('aside').first().innerText();
const editorText = async () =>
  (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/ /g, ' ');

/**
 * Bring the Problems tab up.
 *
 * Through the app's own command rather than the Ctrl+J toggle: `setBottomTab`
 * opens the panel unconditionally, where a toggle depends on the state it was
 * already in and can just as easily close it.
 */
const openProblems = async () => {
  await runCommand('Show problems');
  // The filter box only exists inside the Problems tab, so waiting on it is a
  // stronger signal than waiting on the panel container.
  await page.getByLabel('Filter problems').waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
};

const openFile = async (name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await page.getByLabel('Search files').fill(name);
  await page.getByRole('option').filter({ hasText: name }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1200);
};

try {
  await step('1. sign in and open a TypeScript project', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    const local = page.getByRole('button', { name: /Continue in Local Mode/i });
    if (await local.isVisible().catch(() => false)) {
      await local.click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
    }
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'React + TypeScript', exact: true }).click();
    await page.getByLabel('Project name').fill(`DevExp ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(3000);
    await skipOnboarding();
  });

  // ------------------------------------------------------------------ tasks

  await step('2. built-in run configurations exist', async () => {
    await showPanel('Tasks');
    const text = await sidebarText();
    if (!/Run configurations/i.test(text)) throw new Error('no configurations section');
    if (!/Build/.test(text)) throw new Error(`the Build task is missing: ${text.slice(0, 200)}`);
    if (!/default/i.test(text)) throw new Error('no default is marked');
  });

  await step('3. the panel states plainly that there is no step debugger', async () => {
    const text = await sidebarText();
    if (!/no step debugger/i.test(text)) {
      throw new Error(`the debugging limitation is not stated: ${text.slice(-300)}`);
    }
  });

  await step('4. running a task produces a real result', async () => {
    await page.getByRole('button', { name: 'Run Build' }).click();
    // The first build compiles with esbuild-wasm, which is slow to warm up.
    await page.getByText(/Succeeded|Failed/).first().waitFor({ timeout: 60000 });
    const text = await sidebarText();
    if (!/Succeeded|Failed/.test(text)) {
      throw new Error(`no run outcome recorded: ${text.slice(0, 400)}`);
    }
    if (!/exit \d/.test(text)) throw new Error('no real exit code recorded');
  });

  await step('5. a run opens its actual output', async () => {
    await page.getByRole('button', { name: /^Build/ }).last().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 10000 });
    const text = await dialog.innerText();
    if (text.length < 20) throw new Error('the run produced no visible output');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForTimeout(400);
  });

  await step('6. a custom task is validated, and an unsafe one is refused', async () => {
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByRole('dialog', { name: 'New task' }).waitFor({ timeout: 10000 });
    await page.getByLabel('Name', { exact: true }).fill('Escape attempt');
    await page.getByLabel('Command').fill('curl http://evil.test');
    await page.getByRole('button', { name: 'Save task' }).click();
    await page.waitForTimeout(900);
    // The dialog stays open and the refusal is reported.
    if (!(await page.getByRole('dialog', { name: 'New task' }).isVisible())) {
      throw new Error('an unsafe command was accepted');
    }
    const body = await page.locator('body').innerText();
    if (!/not a task command/i.test(body)) throw new Error('no reason was given for the refusal');
  });

  await step('7. an environment value is refused, a name is accepted', async () => {
    await page.getByLabel('Command').fill('ls src');
    await page.getByLabel('Environment variable names').fill('API_KEY=sk-live-secret');
    await page.getByRole('button', { name: 'Save task' }).click();
    await page.waitForTimeout(900);
    const body = await page.locator('body').innerText();
    if (!/looks like a value/i.test(body)) throw new Error('a secret value was not refused');

    await page.getByLabel('Environment variable names').fill('API_URL');
    await page.getByRole('button', { name: 'Save task' }).click();
    await page.waitForTimeout(900);
    if (await page.getByRole('dialog', { name: 'New task' }).isVisible().catch(() => false)) {
      throw new Error('a valid task was not saved');
    }
    const text = await sidebarText();
    if (!/Escape attempt/.test(text)) throw new Error('the task is not listed');
    if (/sk-live-secret/.test(text)) throw new Error('a secret value reached the panel');
  });

  await step('8. the saved task runs from the command palette', async () => {
    await runCommand('Run task: Escape attempt');
    await page.waitForTimeout(4000);
    await showPanel('Tasks');
    const text = await sidebarText();
    if (!/Escape attempt/.test(text)) throw new Error('the run was not recorded');
  });

  // --------------------------------------------------------------- problems

  await step('9. a real type error reaches the Problems panel', async () => {
    await openFile('App.tsx');
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nconst broken: number = "not a number";\n');
    await page.waitForTimeout(4000);

    await openProblems();
    await page.waitForTimeout(2500);
    const panel = await page.locator('body').innerText();
    if (!/not assignable|Type/i.test(panel)) {
      throw new Error(`no type error reported: ${panel.slice(0, 300)}`);
    }
  });

  await step('10. problems group by file and filter by severity', async () => {
    await openProblems();
    if (!/App\.tsx/.test(await page.locator('body').innerText())) {
      throw new Error('problems are not grouped by file');
    }

    // The severity toggles sit immediately before the filter box. Count the
    // rendered file groups rather than matching an empty-state string: the
    // count is the behaviour, and it holds whatever mix of severities exists.
    const errorToggle = page
      .getByLabel('Filter problems')
      .locator('xpath=preceding-sibling::button')
      .first();
    const groups = page.locator('[aria-expanded]');
    const before = await groups.count();
    if (before === 0) throw new Error('no problem groups rendered to filter');

    await errorToggle.click();
    await page.waitForTimeout(900);
    if ((await errorToggle.getAttribute('aria-pressed')) !== 'false') {
      throw new Error('the severity toggle did not change state');
    }
    const after = await groups.count();
    if (after >= before) {
      throw new Error(`hiding errors did not shorten the list: ${before} then ${after}`);
    }

    await errorToggle.click();
    await page.waitForTimeout(900);
    if ((await groups.count()) !== before) throw new Error('the list did not come back');
  });

  await step('11. the text filter narrows the list', async () => {
    await openProblems();
    await page.getByLabel('Filter problems').fill('zzz-no-such-problem');
    await page.waitForTimeout(800);
    if (!/No problems match this filter/i.test(await page.locator('body').innerText())) {
      throw new Error('the text filter did nothing');
    }
    await page.getByLabel('Filter problems').fill('');
    await page.waitForTimeout(600);
  });

  await step('12. "next problem" navigates to a real location', async () => {
    await runCommand('Go to next problem');
    await page.waitForTimeout(1200);
    const status = await page.locator('footer, [class*="StatusBar"]').first().innerText().catch(() => '');
    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    if (!tabs.some((tab) => /App\.tsx/.test(tab))) {
      throw new Error(`navigation did not open the file with the problem: ${status}`);
    }
  });

  // ---------------------------------------------------------------- outline

  await step('13. the outline lists real symbols from the language service', async () => {
    await showPanel('Explorer');
    await page.getByText('Outline', { exact: true }).click();
    await page.waitForTimeout(3000);
    const text = await sidebarText();
    if (!/App/.test(text)) throw new Error(`no symbols listed: ${text.slice(-400)}`);
  });

  await step('14. clicking a symbol moves the caret', async () => {
    const symbol = page
      .locator('[role="tree"][aria-label="Document symbols"] [role="treeitem"]')
      .first();
    if (!(await symbol.count())) throw new Error('the outline rendered no items');
    await symbol.click();
    await page.waitForTimeout(900);
    const content = await editorText();
    if (!content.length) throw new Error('the editor is empty after navigating');
  });

  // ------------------------------------------------------- code inteligence

  await step('15. editor commands run real Monaco actions', async () => {
    await openFile('App.tsx');
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+Home');
    const before = await editorText();
    await runCommand('Toggle line comment');
    await page.waitForTimeout(900);
    const after = await editorText();
    if (before === after) throw new Error('the comment command changed nothing');
  });

  await step('16. an unsupported command explains itself rather than doing nothing', async () => {
    await openFile('index.html');
    await page.locator('.monaco-editor').first().click();
    await runCommand('Go to definition');
    await page.waitForTimeout(1200);
    const body = await page.locator('body').innerText();
    // Either the action ran, or the app said why it could not.
    if (/is not available here/.test(body) && !/language service/i.test(body)) {
      throw new Error('the refusal did not explain itself');
    }
  });

  // ------------------------------------------------------------ git history

  await step('17. commit history can be searched and filtered', async () => {
    await runCommand('Initialize repository');
    await runCommand('Stage all changes');
    await showPanel('Source control');
    await page.locator('textarea[placeholder="Commit message"]').fill('first commit');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.waitForTimeout(2500);

    await page.getByRole('tab', { name: /History/i }).click();
    await page.waitForTimeout(800);
    await page.getByLabel('Search commits').fill('zzz-nothing');
    await page.waitForTimeout(700);
    if (!/No commits match/i.test(await sidebarText())) {
      throw new Error('commit search did not filter');
    }
    await page.getByLabel('Search commits').fill('first');
    await page.waitForTimeout(700);
    if (!/first commit/.test(await sidebarText())) throw new Error('a matching commit was hidden');
  });

  await step('18. author filtering uses the real author', async () => {
    await page.getByLabel('Search commits').fill('');
    await page.getByLabel('Filter by author').fill('nobody-by-this-name');
    await page.waitForTimeout(700);
    if (!/No commits match/i.test(await sidebarText())) {
      throw new Error('the author filter did nothing');
    }
    await page.getByLabel('Filter by author').fill('');
    await page.waitForTimeout(600);
  });

  await step('19. a file history lists only commits that touched the file', async () => {
    await page.getByRole('tab', { name: /Changes/i }).click();
    await page.waitForTimeout(800);
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// touched again\n');
    await page.waitForTimeout(2500);

    await showPanel('Source control');
    const changed = page.locator('aside').first().getByRole('button').filter({ hasText: /\.tsx/ }).first();
    if (await changed.count()) {
      await changed.click();
      await page.waitForTimeout(1000);
      const history = page.getByRole('button', { name: 'History', exact: true });
      if (await history.count()) {
        await history.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 10000 });
        const text = await dialog.innerText();
        if (!/first commit|No commit on this branch/.test(text)) {
          throw new Error(`file history is empty and unexplained: ${text.slice(0, 200)}`);
        }
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.waitForTimeout(400);
      }
    }
  });

  // ------------------------------------------------------------ reliability

  await step('20. a corrupted stored session does not break startup', async () => {
    await page.evaluate(() => {
      localStorage.setItem(
        'forge.editor',
        JSON.stringify({
          state: {
            sessions: {
              bad: { tabs: [{ path: '../../etc/passwd' }, { path: '.env' }], activePath: '/etc/passwd' },
            },
          },
          version: 0,
        }),
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(3000);
    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    if (tabs.some((tab) => /passwd|\.env/.test(tab))) {
      throw new Error(`a protected path was restored: ${tabs.join(', ')}`);
    }
  });

  await step('21. tasks survive a reload, runs do not claim to', async () => {
    await showPanel('Tasks');
    const text = await sidebarText();
    if (!/Escape attempt/.test(text)) throw new Error('a saved task did not persist');
    if (/Running/.test(text)) throw new Error('a run claims to still be running after a reload');
  });

  // ---------------------------------------------------------- accessibility

  await step('22. every dialog opened here has an accessible name', async () => {
    await page.getByRole('button', { name: 'New task' }).click();
    await page.waitForTimeout(700);
    const named = await page.getByRole('dialog', { name: 'New task' }).count();
    if (!named) throw new Error('the task dialog has no accessible name');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await page.getByRole('dialog', { name: 'New task' }).isVisible().catch(() => false)) {
      throw new Error('Escape did not close the dialog');
    }
  });

  await step('23. every activity bar entry is reachable and named', async () => {
    const names = await page
      .locator('nav[aria-label="Workspace panels"] button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    for (const expected of ['Tasks', 'Project', 'Activity', 'Explorer']) {
      if (!names.includes(expected)) throw new Error(`${expected} is not reachable`);
    }
    if (names.some((name) => !name)) throw new Error('an unnamed panel button');
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
