/**
 * Browser end-to-end for the GitHub integration.
 *
 * The whole shipping stack runs for real — the store, the GitHub client, the
 * Git planner, the Source Control panel — against a GitHub Git Data API that
 * stores genuine git objects and enforces genuine fast-forward rules
 * (`e2e/github-server.ts`, the same implementation the unit tests use, proven
 * byte-identical to `git` in `src/lib/github/objects.test.ts`).
 *
 * The one thing substituted is the network hop: Playwright routes
 * `https://api.github.com` to that local server. Assertions read the server's
 * state afterwards, so a push is only "verified" if a real git commit exists
 * on a real branch with the expected tree.
 *
 *   npx vite-node e2e/github-server.ts &
 *   node e2e/github.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.FORGE_GITHUB_API ?? 'http://127.0.0.1:8877';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? '.';
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;

const consoleErrors = [];
const pageErrors = [];
let passed = 0;
let failed = 0;

const control = async (path, body) => {
  const response = await fetch(`${API}/__control/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`control ${path}: HTTP ${response.status}`);
  return response.json();
};

const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

// Point the app's GitHub calls at the local API. Nothing in the application is
// aware of this: it still builds api.github.com URLs and still sends its
// Authorization header.
await context.route('https://api.github.com/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const response = await fetch(`${API}${url.pathname}${url.search}`, {
    method: request.method(),
    headers: { 'content-type': 'application/json' },
    body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postData() ?? undefined,
  });
  const text = await response.text();
  const headers = {};
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  await route.fulfill({
    status: response.status,
    headers: { ...headers, 'content-type': 'application/json' },
    body: text,
  });
});

const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: `${OUT}/gh-fail-${name.replace(/\W+/g, '-').slice(0, 60)}.png` }).catch(() => {});
  }
};

const signIn = async () => {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  const local = page.getByRole('button', { name: /Continue in Local Mode/i });
  if (await local.isVisible().catch(() => false)) {
    await local.click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
  }
};

const openSourceControl = async () => {
  const button = page.getByRole('button', { name: 'Source control', exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForTimeout(500);
};

const remoteState = async () => control('state');

/**
 * Open a file and wait until the editor is really showing it. Typing into
 * whatever happened to be focused is how a browser test silently stops
 * testing what it claims to.
 */
const openFile = async (name) => {
  const active = page
    .locator('[role="tablist"][aria-label="Open editors"] [role="tab"][aria-selected="true"]')
    .filter({ hasText: name });
  if (await active.count()) {
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    return;
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await page.getByLabel('Search files').fill(name);
  // Wait for the exact entry rather than trusting the first result's order.
  await page.getByRole('option').filter({ hasText: name }).first().click({ timeout: 15000 });
  await active.waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
};

const typeAtEnd = async (text) => {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
};

const commitAll = async (message) => {
  await openSourceControl();
  await page.getByRole('button', { name: /Stage all/i }).click();
  await page.waitForTimeout(700);
  await page.getByPlaceholder('Commit message').fill(message);
  await page.getByRole('button', { name: /^Commit$/ }).click();
  await page.waitForTimeout(2000);
};

try {
  await control('reset', {
    repos: [
      { owner: 'forge-tester', name: 'demo', files: { 'README.md': '# demo\n' } },
      { owner: 'forge-tester', name: 'empty' },
      { owner: 'forge-tester', name: 'readonly', files: { 'a.txt': 'a\n' }, canPush: false },
    ],
  });

  await step('1. sign in and connect GitHub with a token', async () => {
    await signIn();
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.getByLabel('Personal access token').fill('test-token');
    await page.getByRole('button', { name: /^Connect GitHub$/ }).click();
    await page.getByText('forge-tester').first().waitFor({ timeout: 20000 });
  });

  await step('2. the connection survives a reload and can be refreshed', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.getByText('forge-tester').first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: /Refresh/ }).click();
    await page.waitForTimeout(800);
    await page.getByText('forge-tester').first().waitFor({ timeout: 10000 });
  });

  await step('3. import a repository from the connected account', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Import$/ }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('tab', { name: /Your GitHub/i }).click();
    await page.getByRole('button', { name: /forge-tester\/demo/ }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Import forge-tester\/demo$/ }).click();
    await page.waitForURL('**/project/**', { timeout: 60000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
  });

  await step('4. the imported project has the repository contents', async () => {
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('README');
    await page.waitForTimeout(600);
    const options = await page.getByRole('option').allInnerTexts();
    await page.keyboard.press('Escape');
    if (!options.some((o) => o.includes('README.md'))) {
      throw new Error(`README.md not in the imported project: ${options.join(', ')}`);
    }
  });

  await step('5. the panel shows the connected repository and branch', async () => {
    await openSourceControl();
    const text = await page.locator('aside').first().innerText();
    if (!/forge-tester\/demo/.test(text)) throw new Error(`no repository shown: ${text.slice(0, 200)}`);
    if (!/\bmain\b/.test(text)) throw new Error('no branch shown');
  });

  await step('6. fetch reports the repository is up to date', async () => {
    await page.getByRole('button', { name: /^Fetch$/ }).click();
    await page.getByText(/Already up to date|up to date/i).first().waitFor({ timeout: 20000 });
  });

  await step('7. modify a file and commit locally', async () => {
    await openFile('README.md');
    await typeAtEnd('\nEdited in Forge.\n');
    await commitAll('Edit the readme');
  });

  await step('8. the panel reports one outgoing commit', async () => {
    await openSourceControl();
    const text = await page.locator('aside').first().innerText();
    if (!/1 outgoing/.test(text)) throw new Error(`no outgoing count: ${text.slice(0, 300)}`);
  });

  await step('9. push, and GitHub really has the commit', async () => {
    await page.getByRole('button', { name: /^Push$/ }).click();
    await page.waitForTimeout(4000);
    const state = await remoteState();
    const main = state['forge-tester/demo'].refs.main;
    if (!/Edited in Forge\./.test(main.files['README.md'] ?? '')) {
      throw new Error(`the push did not reach the branch: ${JSON.stringify(main.files)}`);
    }
  });

  await step('10. a second push has nothing to send', async () => {
    const before = (await remoteState())['forge-tester/demo'].refs.main.sha;
    await page.getByRole('button', { name: /^Push$/ }).click();
    await page.waitForTimeout(3000);
    const after = (await remoteState())['forge-tester/demo'].refs.main.sha;
    if (before !== after) throw new Error('an empty push moved the branch');
  });

  await step('11. a remote change is seen by fetch', async () => {
    const current = (await remoteState())['forge-tester/demo'].refs.main.files;
    await control('commit', {
      owner: 'forge-tester',
      name: 'demo',
      branch: 'main',
      files: { ...current, 'CHANGELOG.md': '# changes\n' },
      message: 'Add a changelog',
    });
    await page.getByRole('button', { name: /^Fetch$/ }).click();
    await page.waitForTimeout(3000);
    const text = await page.locator('aside').first().innerText();
    if (!/1 incoming/.test(text)) throw new Error(`fetch did not report the change: ${text.slice(0, 300)}`);
  });

  await step('12. pull fast-forwards the remote change into the project', async () => {
    await page.getByRole('button', { name: /^Pull$/ }).click();
    await page.waitForTimeout(4000);
    await page.keyboard.press('Control+P');
    await page.getByLabel('Search files').fill('CHANGELOG');
    await page.waitForTimeout(600);
    const options = await page.getByRole('option').allInnerTexts();
    await page.keyboard.press('Escape');
    if (!options.some((o) => o.includes('CHANGELOG.md'))) {
      throw new Error('the pulled file is not in the project');
    }
  });

  await step('13. a divergent change becomes a conflict with markers', async () => {
    // Both sides edit the same line of the same file.
    const current = (await remoteState())['forge-tester/demo'].refs.main.files;
    await control('commit', {
      owner: 'forge-tester',
      name: 'demo',
      branch: 'main',
      files: { ...current, 'CHANGELOG.md': '# changes\nfrom github\n' },
      message: 'Remote edit',
    });

    await openFile('CHANGELOG.md');
    // Type only once the editor really shows the pre-edit content. Without
    // this the step can race a slow model load and silently edit stale text,
    // which produces a clean merge and a confusing failure two steps later.
    await page
      .locator('.monaco-editor .view-lines')
      .first()
      .filter({ hasText: '# changes' })
      .waitFor({ timeout: 20000 });
    const baseline = await page.locator('.monaco-editor .view-lines').first().innerText();
    if (/from github/.test(baseline)) {
      throw new Error(`the editor already shows the remote edit: ${baseline.slice(0, 120)}`);
    }
    await typeAtEnd('from forge\n');
    await commitAll('Local edit');

    // The conflict only means anything if both sides really diverged.
    const before = await page.locator('aside').first().innerText();
    if (!/outgoing/.test(before)) {
      throw new Error(`the local commit did not land, so nothing can conflict: ${before.slice(0, 300)}`);
    }

    await page.getByRole('button', { name: /^Pull$/ }).click();
    await page.waitForTimeout(5000);
    const panel = await page.locator('aside').first().innerText();
    if (!/[Cc]onflict|[Mm]erge in progress/.test(panel)) {
      throw new Error(`no conflict reported: ${panel.slice(0, 400)}`);
    }
  });

  await step('14. the conflict markers are really in the file', async () => {
    await openFile('CHANGELOG.md');
    const text = await page.locator('.monaco-editor .view-lines').first().innerText();
    if (!text.includes('<<<<<<<')) throw new Error(`no conflict markers in the editor: ${text.slice(0, 200)}`);
  });

  await step('15. push and pull are blocked, with a way out, while merging', async () => {
    await openSourceControl();
    const push = page.getByRole('button', { name: /^Push$/ });
    const pull = page.getByRole('button', { name: /^Pull$/ });
    if (!(await push.isDisabled())) throw new Error('push was offered during an unresolved merge');
    if (!(await pull.isDisabled())) throw new Error('pull was offered during an unresolved merge');
    const text = await page.locator('aside').first().innerText();
    if (!/Merge in progress/.test(text)) throw new Error(`no merge state shown: ${text.slice(0, 300)}`);
    if (!/Resolve the marked files/.test(text)) {
      throw new Error(`no instruction for getting out of the merge: ${text.slice(0, 300)}`);
    }
  });

  await step('16. resolving, committing and pushing lands the merge on GitHub', async () => {
    await openFile('CHANGELOG.md');
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('# changes\nresolved\n');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1500);

    await openSourceControl();
    await page.getByRole('button', { name: /Stage all/i }).click();
    await page.waitForTimeout(500);
    await page.getByPlaceholder('Commit message').fill('Resolve the conflict');
    await page.getByRole('button', { name: /Commit & Push/ }).click();
    await page.waitForTimeout(6000);

    const state = await remoteState();
    const content = state['forge-tester/demo'].refs.main.files['CHANGELOG.md'] ?? '';
    if (!/resolved/.test(content) || /<<<<<<</.test(content)) {
      throw new Error(`the resolved content is not on GitHub: ${JSON.stringify(content)}`);
    }
  });

  await step('17. the panel is back in sync after the round trip', async () => {
    await page.getByRole('button', { name: /^Fetch$/ }).click();
    await page.waitForTimeout(3000);
    const text = await page.locator('aside').first().innerText();
    if (/outgoing|incoming/.test(text)) throw new Error(`still out of sync: ${text.slice(0, 300)}`);
    if (!/Up to date/.test(text)) throw new Error(`no in-sync summary: ${text.slice(0, 300)}`);
  });

  await step('18. the state survives a full reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await openSourceControl();
    const text = await page.locator('aside').first().innerText();
    if (!/forge-tester\/demo/.test(text)) throw new Error('the remote was lost on reload');
  });

  await step('19. a first push to an empty repository creates the branch', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill('Empty Repo Push');
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });

    await openSourceControl();
    await page.getByRole('button', { name: /Initialize repository/i }).click();
    await page.waitForTimeout(1500);
    await openSourceControl();
    await page.getByRole('button', { name: /Connect a GitHub repository/i }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: /forge-tester\/empty/ }).click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Connect repository/i }).click();
    await page.waitForTimeout(1500);

    await openSourceControl();
    await page.getByRole('button', { name: /Stage all/i }).click();
    await page.waitForTimeout(600);
    await page.getByPlaceholder('Commit message').fill('First commit');
    await page.getByRole('button', { name: /Commit & Push/ }).click();
    await page.waitForTimeout(7000);

    const state = await remoteState();
    const main = state['forge-tester/empty']?.refs?.main;
    if (!main) throw new Error('the branch was not created on the empty repository');
    if (!main.files['index.html']) throw new Error(`the project did not land: ${JSON.stringify(Object.keys(main.files))}`);
  });

  await step('20. a repository the account cannot push to is marked read-only', async () => {
    await openSourceControl();
    await page.getByRole('button', { name: 'Disconnect this repository' }).click();
    await page.getByRole('button', { name: /^Disconnect$/ }).click();
    await page.waitForTimeout(1200);
    await openSourceControl();
    await page.getByRole('button', { name: /Connect a GitHub repository/i }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: /Search repositories/i }).fill('readonly').catch(async () => {
      await page.getByLabel('Search repositories').fill('readonly');
    });
    await page.waitForTimeout(1500);
    const row = page.getByRole('button', { name: /forge-tester\/readonly/ });
    await row.waitFor({ timeout: 10000 });
    if (!(await row.isDisabled())) throw new Error('a read-only repository was offered for push');
    await page.getByRole('button', { name: /^Cancel$/ }).click();
  });

  await step('21. a rate limit is explained rather than shown as a failure', async () => {
    await control('fail', {
      failWith: {
        status: 403,
        message: 'API rate limit exceeded',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) },
      },
    });
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Refresh/ }).click().catch(() => {});
    await page.waitForTimeout(2500);
    const text = await page.locator('body').innerText();
    if (!/rate limit/i.test(text)) throw new Error(`the rate limit was not explained: ${text.slice(0, 300)}`);
    await control('fail', { failWith: null });
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
