/**
 * Preview pipeline and runtime-correctness matrix.
 *
 * Each concern gets its own fresh project so one failure cannot cascade into
 * the next. Every assertion inspects what the sandboxed iframe actually
 * rendered, or what the Output/Problems panels actually contain.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? 'e2e/artifacts';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.FORGE_E2E_CHROMIUM ? { executablePath: process.env.FORGE_E2E_CHROMIUM } : {},
);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

/**
 * Dismiss the first-run tour.
 *
 * A first-time user really does see it, so every suite that opens a project
 * for the first time has to get past it the same way a person would.
 */
const skipOnboarding = async () => {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(400);
  }
};

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));
page.on('requestfailed', (r) => {
  // Vite aborts in-flight module requests on navigation; only off-origin
  // failures matter for the "no network" claim.
  if (!r.url().includes('127.0.0.1')) failedRequests.push(`${r.failure()?.errorText} ${r.url()}`);
});

let passed = 0;
const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${String(error.message).split('\n').slice(0, 3).join(' | ')}`);
    failures.push(name);
    await page.screenshot({ path: `${OUT}/pm-fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
};

const frame = () => page.frameLocator('iframe[title="Project preview"]');

async function signIn() {
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  const local = page.getByRole('button', { name: /Continue in Local Mode/i });
  if (await local.isVisible().catch(() => false)) {
    await local.click();
    await page.waitForURL('**/dashboard', { timeout: 20000 });
  }
}

async function createProject(templateName, name) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /New project/i }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: templateName, exact: true }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: /Create project/i }).click();
  await page.waitForURL('**/project/**', { timeout: 30000 });
  await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
}

async function waitForRunning() {
  await page.getByText(/running ·/i).waitFor({ timeout: 150000 });
}

async function openFile(name) {
  await page.keyboard.press('Control+P');
  await page.getByLabel('Search files').fill(name);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.locator('.monaco-editor .view-lines').first().click();
}

async function typeAtTop(text) {
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(text);
  await page.keyboard.press('Control+s');
}

async function typeAtEnd(text) {
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await page.keyboard.press('Control+s');
}

async function shell(command) {
  await page.getByRole('tab', { name: /Terminal/i }).click();
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  return page.locator('.xterm-screen').innerText();
}

async function outputText(expected, timeout = 20000) {
  await page.getByRole('tab', { name: /Output/i }).click();
  const deadline = Date.now() + timeout;
  let text = '';
  do {
    text = await page.locator('section[aria-label="Panel"]').innerText();
    if (!expected || expected.test(text)) return text;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return text;
}

async function problemsText() {
  await page.getByRole('tab', { name: /Problems/i }).click();
  await page.waitForTimeout(500);
  return page.locator('section[aria-label="Panel"]').innerText();
}



try {
  await signIn();

  // ---------------------------------------------------------------- vanilla
  await step('vanilla: renders, styled, and logs to Output', async () => {
    await createProject('Vanilla HTML/CSS/JS', 'M Vanilla');
    await waitForRunning();
    await frame().getByRole('heading', { name: /Vanilla App/i }).waitFor({ timeout: 40000 });
    const bg = await frame().locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    if (bg !== 'rgb(11, 15, 23)') throw new Error(`stylesheet not applied, background ${bg}`);
    const text = await outputText(/Vanilla app ready/);
    if (!/Vanilla app ready/.test(text)) throw new Error('console.log did not reach Output');
  });

  await step('vanilla: DOM events run inside the sandbox', async () => {
    await frame().getByRole('button', { name: /Clicked 0 times/i }).click();
    await frame().getByRole('button', { name: /Clicked 1 time$/ }).waitFor({ timeout: 10000 });
  });

  // ------------------------------------------------------------------ React
  await step('react: renders with React bundled locally', async () => {
    await createProject('React', 'M React');
    await waitForRunning();
    await frame().getByRole('heading', { name: /React App/i }).waitFor({ timeout: 60000 });
  });

  await step('react: hooks and child component state work', async () => {
    await page.waitForTimeout(2000);
    await frame().getByRole('button', { name: /Clicked 0 times/i }).click();
    await frame().getByRole('button', { name: /Clicked 1 time$/ }).waitFor({ timeout: 10000 });
  });

  await step('react: build log shows local bundling and no CDN', async () => {
    const text = await outputText(/Bundled locally \(no network\)/);
    if (!/Bundled locally \(no network\)/.test(text)) {
      throw new Error(`no local-bundle line:\n${text.slice(0, 500)}`);
    }
    if (!/react-dom\/client/.test(text)) throw new Error('react-dom/client was not bundled locally');
    if (/Loaded from (esm\.sh|jsdelivr)/.test(text)) throw new Error('still needs a CDN');
  });

  // -------------------------------------------------------------- React TS
  await step('react-ts: TypeScript template renders and reacts', async () => {
    await createProject('React + TypeScript', 'M React TS');
    await waitForRunning();
    await frame().getByRole('heading', { name: /React \+ TypeScript/i }).waitFor({ timeout: 60000 });
    await frame().getByRole('button', { name: /Clicked 0 times/i }).click();
    await frame().getByRole('button', { name: /Clicked 1 time$/ }).waitFor({ timeout: 10000 });
  });

  // --------------------------------------------------------------- Vite TS
  await step('vite-ts: bundler template renders', async () => {
    await createProject('Vite + TypeScript', 'M Vite TS');
    await waitForRunning();
    await frame().getByRole('heading', { name: /Vite \+ TypeScript/i }).waitFor({ timeout: 60000 });
  });

  // ------------------------------------------ multi-file / css / json imports
  await step('imports: nested, re-exported, CSS and JSON all resolve', async () => {
    await createProject('Vite + TypeScript', 'M Imports');
    await waitForRunning();

    await shell(`mkdir src/data`);
    await shell(`echo '{"label":"json-ok","count":7}' > src/data/config.json`);
    await shell(`echo '.probe { color: rgb(1, 2, 3); }' > src/probe.css`);
    await shell(`echo 'export const triple = (n: number) => n * 3;' > src/data/nested.ts`);
    await shell(`echo 'export { triple } from "./data/nested";' > src/reexport.ts`);

    await openFile('main.ts');
    await typeAtTop(
      `import config from './data/config.json';\n` +
        `import { triple } from './reexport';\n` +
        `import './probe.css';\n` +
        `console.log('chain:' + config.label + ':' + triple(config.count));\n`,
    );
    await page.waitForTimeout(6000);

    const text = await outputText(/chain:json-ok:21/);
    if (!/chain:json-ok:21/.test(text)) {
      throw new Error(`import chain did not execute:\n${text.slice(0, 700)}`);
    }
  });

  await step('imports: the imported stylesheet lands in the document', async () => {
    const found = await frame()
      .locator('body')
      .evaluate(() =>
        [...document.querySelectorAll('style')].some((s) =>
          (s.textContent ?? '').includes('rgb(1, 2, 3)'),
        ),
      );
    if (!found) throw new Error('CSS import was not injected');
  });

  // ---------------------------------------------------------- runtime errors
  await step('runtime: an uncaught exception reaches the Output panel', async () => {
    await createProject('Vanilla HTML/CSS/JS', 'M Runtime Error');
    await waitForRunning();
    await openFile('main.js');
    await typeAtEnd(`\nsetTimeout(function () { throw new Error('boom-from-preview'); }, 20);\n`);
    await page.waitForTimeout(6000);
    const text = await outputText(/boom-from-preview/);
    if (!/boom-from-preview/.test(text)) {
      throw new Error(`runtime error not reported:\n${text.slice(0, 700)}`);
    }
  });

  await step('runtime: the in-preview error overlay appears', async () => {
    await frame().locator('[data-forge-overlay]').waitFor({ timeout: 20000 });
  });

  // ------------------------------------------------------------ build errors
  await step('build: a syntax error is listed in Problems with a location', async () => {
    await createProject('Vite + TypeScript', 'M Build Error');
    await waitForRunning();

    // A separate file keeps the edit deterministic: it can be broken and
    // restored by writing whole contents, with no reliance on undo history.
    await shell(`echo 'export const extra = 1;' > src/extra.ts`);
    await openFile('main.ts');
    await typeAtTop(`import './extra';\n`);
    await page.waitForTimeout(4000);
    await frame().getByRole('heading', { name: /Vite \+ TypeScript/i }).waitFor({ timeout: 40000 });

    await shell(`echo 'function broken( {' > src/extra.ts`);
    await page.waitForTimeout(6000);
    const text = await problemsText();
    if (!/esbuild/.test(text)) throw new Error(`no esbuild diagnostic:\n${text.slice(0, 600)}`);
    if (!/extra\.ts/.test(text)) throw new Error(`diagnostic missing the file:\n${text.slice(0, 600)}`);
  });

  await step('build: the preview shows a build-failed page', async () => {
    await frame().getByText(/Build failed/i).waitFor({ timeout: 25000 });
  });

  await step('build: fixing the file restores the preview', async () => {
    await shell(`echo 'export const extra = 1;' > src/extra.ts`);
    await page.waitForTimeout(6000);
    await frame().getByRole('heading', { name: /Vite \+ TypeScript/i }).waitFor({ timeout: 40000 });
  });

  // ------------------------------------------------------ missing dependency
  await step('missing dependency: blocked CDN produces an actionable error', async () => {
    await createProject('Vite + TypeScript', 'M Missing Dep');
    await waitForRunning();
    await openFile('main.ts');
    await typeAtTop(`import confetti from 'canvas-confetti';\nvoid confetti;\n`);
    await page.waitForTimeout(12000);
    const body = await frame().locator('body').innerText();
    if (!/canvas-confetti/.test(body)) {
      throw new Error(`package not named in the error:\n${body.slice(0, 600)}`);
    }
    if (!/Settings|CDN|reach/i.test(body)) {
      throw new Error(`error is not actionable:\n${body.slice(0, 600)}`);
    }
  });

  // ------------------------------------------------- stop / start / refresh
  await step('preview: stop, run and refresh all work', async () => {
    await createProject('Vanilla HTML/CSS/JS', 'M Lifecycle');
    await waitForRunning();

    await page.getByRole('button', { name: /^Stop$/ }).first().click();
    await page.getByText(/Preview is stopped/i).waitFor({ timeout: 15000 });

    await page.getByRole('button', { name: /^Run$/ }).first().click();
    await waitForRunning();
    await frame().getByRole('heading', { name: /Vanilla App/i }).waitFor({ timeout: 40000 });

    await page.getByRole('button', { name: /Reload the preview/i }).click();
    await page.waitForTimeout(2000);
    await frame().getByRole('heading', { name: /Vanilla App/i }).waitFor({ timeout: 40000 });
  });

  await step('preview: editing a file triggers a rebuild', async () => {
    await openFile('main.js');
    await typeAtEnd(`\nconsole.log('rebuild-marker-42');\n`);
    await page.waitForTimeout(6000);
    const text = await outputText(/rebuild-marker-42/);
    if (!/rebuild-marker-42/.test(text)) {
      throw new Error(`edit did not rebuild:\n${text.slice(0, 600)}`);
    }
  });

  await page.screenshot({ path: `${OUT}/pm-final.png` });
} finally {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
  console.log('--- console errors ---');
  console.log(consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 10).join('\n') : '(none)');
  console.log('--- page errors ---');
  console.log(pageErrors.length ? pageErrors.slice(0, 5).join('\n') : '(none)');
  console.log('--- off-origin request failures ---');
  console.log(failedRequests.length ? [...new Set(failedRequests)].slice(0, 10).join('\n') : '(none)');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}
