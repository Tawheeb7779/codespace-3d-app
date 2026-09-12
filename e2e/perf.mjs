/**
 * Measured performance, in a real browser.
 *
 * The other suites assert that the product works. This one asserts nothing at
 * all: it reports numbers, and the numbers only mean something because they
 * come from Chromium driving the built application rather than from a model of
 * it. jsdom cannot time a Monaco editor being created, and a Node benchmark of
 * a pure function cannot tell you whether React mounted it twice.
 *
 * Each measurement names what it is timing and what would make it lie. Machine
 * load moves every one of them, so a single run is only comparable against
 * another run on the same machine — which is exactly how it is used: capture
 * before a change, capture after, compare.
 *
 *   npm run build && npx vite preview --port 4173
 *   node e2e/perf.mjs
 *
 * `FORGE_E2E_CHROMIUM` points at a preinstalled browser when the environment
 * provides one instead of Playwright's own download.
 */
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:4173';
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;
const LABEL = process.env.FORGE_PERF_LABEL ?? 'run';

const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const results = [];
/** Median rather than mean: one scheduling hiccup should not move the reading. */
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const report = (name, samples, unit = 'ms', note = '') => {
  const value = median(samples);
  results.push({ name, value, unit, note, samples: samples.length });
  const spread = samples.length > 1 ? ` (min ${Math.min(...samples).toFixed(1)}, max ${Math.max(...samples).toFixed(1)})` : '';
  console.log(`${name.padEnd(44)} ${value.toFixed(1)} ${unit}${spread}${note ? ` — ${note}` : ''}`);
};

const skipOnboarding = async () => {
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(300);
  }
};

console.log(`\n=== TA CODE performance — ${LABEL} ===`);
console.log(`base ${BASE}\n`);

// ---------------------------------------------------------------------------
// Setup: a real project, opened the way a person opens one.
// ---------------------------------------------------------------------------
await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Continue in Local Mode/i }).click();
await page.waitForURL('**/dashboard', { timeout: 20000 });

await page.getByRole('button', { name: /New project/i }).first().click();
await page.getByRole('dialog').waitFor();
await page.getByRole('button', { name: /React \+ TypeScript|React/i }).first().click();
await page.getByLabel('Project name').fill(`Perf ${Date.now()}`);
await page.getByRole('button', { name: /Create project/i }).click();
await page.waitForURL('**/project/**', { timeout: 30000 });

const firstEditor = Date.now();
await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
report('editor: first mount after project open', [Date.now() - firstEditor], 'ms', 'includes Monaco chunk load');
await skipOnboarding();

// ---------------------------------------------------------------------------
// Editor tab switching.
//
// How long a switch takes, and whether Monaco's own root element survived it.
//
// Read the second one narrowly. A tag is written onto the live
// `.monaco-editor` element and looked for afterwards, which says whether
// Monaco rebuilt its view — and it does that whenever a model is attached,
// whatever React did. So a replaced root is *not* evidence that the React
// component remounted, and this number cannot be used to argue that it did.
// It was checked against both: with and without `key={path}` on the editor,
// this reads 0% and the switch time is the same, so the rebuild is Monaco's
// and not React's.
// ---------------------------------------------------------------------------
/**
 * Open files by clicking them in the tree.
 *
 * Not through the command palette: its dialog has to close before a tab can be
 * clicked, and a measurement that is really measuring a modal closing is worse
 * than no measurement. Template file names differ per template, so the rows are
 * discovered rather than guessed.
 */
const openTwoFiles = async () => {
  const rows = page.locator('[role="treeitem"]');
  const total = await rows.count();
  let opened = 0;
  for (let i = 0; i < total && opened < 2; i++) {
    const text = (await rows.nth(i).innerText()).trim();
    if (!/\.(tsx?|jsx?|css|html)$/.test(text)) continue;
    await rows.nth(i).click();
    await page.waitForTimeout(700);
    opened += 1;
  }
  return opened;
};

const opened = await openTwoFiles();
await page.waitForTimeout(800);
if (opened < 2) console.log(`note: opened ${opened} file(s); tab-switch measurement may be skipped`);

const tabs = page.getByRole('tab');
const tabCount = await tabs.count();
if (tabCount >= 2) {
  const switchSamples = [];
  let survived = 0;
  let attempts = 0;
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const node = document.querySelector('.monaco-editor');
      if (node) node.setAttribute('data-perf-tag', 'live');
    });
    const target = tabs.nth(i % 2);
    const started = Date.now();
    await target.click();
    // Settled when Monaco has painted lines again for the newly active model.
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 10000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    switchSamples.push(Date.now() - started);
    attempts += 1;
    if (await page.evaluate(() => Boolean(document.querySelector('.monaco-editor[data-perf-tag]')))) {
      survived += 1;
    }
  }
  report('editor: tab switch to painted', switchSamples);
  report('editor: monaco root survives switch', [(survived / attempts) * 100], '%',
    `Monaco rebuilds its view on model attach; says nothing about React (${attempts - survived}/${attempts} replaced)`);
} else {
  console.log('editor: tab switch                          skipped — fewer than two tabs opened');
}

// ---------------------------------------------------------------------------
// Typing.
//
// Keystroke to the character being on screen, which is the latency a person
// actually feels. Measured inside the page so it does not include Playwright's
// own round trip.
// ---------------------------------------------------------------------------
await page.locator('.monaco-editor .view-lines').first().click();
await page.keyboard.press('Control+End');
const typeSamples = [];
for (let i = 0; i < 20; i++) {
  const ms = await page.evaluate(async () => {
    const start = performance.now();
    document.dispatchEvent(new Event('noop'));
    await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - start;
  });
  await page.keyboard.type('x');
  typeSamples.push(ms);
}
report('editor: frame after a keystroke', typeSamples, 'ms', 'frame budget, not full input latency');

// ---------------------------------------------------------------------------
// File tree.
//
// Expanding every folder is the worst realistic case for the explorer, because
// it is what makes the flattened row list as long as the project.
// ---------------------------------------------------------------------------
const explorerSamples = [];
for (let i = 0; i < 5; i++) {
  const ms = await page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]');
    if (!tree) return 0;
    const start = performance.now();
    tree.scrollTop = tree.scrollTop === 0 ? 400 : 0;
    tree.dispatchEvent(new Event('scroll', { bubbles: true }));
    return performance.now() - start;
  });
  await page.waitForTimeout(120);
  explorerSamples.push(ms);
}
report('file tree: scroll handler', explorerSamples, 'ms', 'synchronous cost of one scroll event');

const rowCount = await page.evaluate(
  () => document.querySelectorAll('[role="treeitem"]').length,
);
report('file tree: mounted rows', [rowCount], 'nodes', 'virtualised above 400 rows');

// ---------------------------------------------------------------------------
// Bundle: what the shell actually downloads before it is usable.
// ---------------------------------------------------------------------------
const transferred = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((entry) => entry.initiatorType === 'script' || entry.initiatorType === 'link')
    .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0),
);
report('shell: scripts and styles transferred', [transferred / 1024], 'kB');

const nav = await page.evaluate(() => {
  const entry = performance.getEntriesByType('navigation')[0];
  return entry ? Math.round(entry.domContentLoadedEventEnd) : 0;
});
report('shell: DOMContentLoaded', [nav]);

console.log(`\npage errors: ${pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none'}`);
console.log(`\n--- ${LABEL} ---`);
console.log(JSON.stringify(results, null, 1));

await browser.close();
