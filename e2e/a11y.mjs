/**
 * The accessibility floor, measured in a real browser.
 *
 * Two of this project's audits already gate the build — contrast and the
 * text-node reconciliation hazard — and both work because they measure rather
 * than remind. This one covers the rule they cannot see: a pointer target must
 * be at least 24x24 CSS px, and whether a control clears that depends on
 * layout, on the viewport, and on the pointer type. None of it is visible in
 * the source.
 *
 * It is not in `npm run verify`, deliberately. The static audits need nothing
 * but files; this needs a production build, a server and a browser, which is
 * what every other suite in this directory needs and why they all live outside
 * the main gate.
 *
 * The measurement is the fiddly part, and getting it wrong is how a pass
 * becomes meaningless. The painted box is *not* the hit area:
 *
 *  - `.tap-target` grows a control to 32px through a transparent `::after`,
 *    but only under `(pointer: coarse)`. A 16px close button is compliant on a
 *    phone and irrelevant on a desktop, and reading its `getBoundingClientRect`
 *    reports 16px in both.
 *  - A small control inside a `<label>` is fine, because the label is the
 *    target.
 *
 * Both are accounted for below. A first version of this check ignored them and
 * reported four violations that were not violations.
 *
 *   npm run build && npx vite preview --port 4173
 *   node e2e/a11y.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:4173';
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;
/** The WCAG 2.2 AA web threshold. The native one is 44; this is not native. */
const MIN_TARGET = 24;

const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  args: ['--no-sandbox'],
});

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Open a real project the way a person does. */
async function openProject(page, name) {
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Continue in Local Mode/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  await page.getByRole('button', { name: /New project/i }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: /Vanilla/i }).first().click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: /Create project/i }).click();
  await page.waitForURL('**/project/**', { timeout: 30000 });
  await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(400);
  }
}

/** Every visible interactive control whose effective hit area is too small. */
const UNDERSIZED = (min) => {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const selector =
    'button, a[href], [role="tab"], [role="treeitem"], [role="option"], input:not([type=hidden]), select';
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      continue;
    }
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;

    let width = box.width;
    let height = box.height;
    // The transparent pseudo-element, which only exists under a coarse pointer.
    if (coarse && el.classList.contains('tap-target')) {
      width = Math.max(width, 32);
      height = Math.max(height, 32);
    }
    // A control inside a label is as big as its label.
    const label = el.closest('label');
    if (label) {
      const labelBox = label.getBoundingClientRect();
      width = Math.max(width, labelBox.width);
      height = Math.max(height, labelBox.height);
    }

    if (width < min || height < min) {
      const name =
        el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName;
      out.push(`${name} (${Math.round(width)}x${Math.round(height)})`);
    }
  }
  return { coarse, violations: out };
};

// ---------------------------------------------------------------------------
// Touch targets, on a phone, across every pane.
//
// Per pane because the mobile workspace mounts exactly one at a time, so a
// single snapshot of the document sees a fifth of the product.
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await openProject(page, `A11y phone ${Date.now()}`);

  for (const pane of ['Files', 'Editor', 'Preview', 'Terminal', 'Assistant']) {
    const button = page.getByRole('button', { name: new RegExp(`^${pane}$`, 'i') }).last();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(700);
    }
    const { coarse, violations } = await page.evaluate(UNDERSIZED, MIN_TARGET);
    if (pane === 'Files') check('phone reports a coarse pointer', coarse);
    check(
      `phone · ${pane} pane · targets >= ${MIN_TARGET}px`,
      violations.length === 0,
      violations.slice(0, 5).join(', '),
    );
  }

  // The workspace must not need sideways scrolling to be used.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check('phone · no horizontal page scroll', !overflows);
  await page.close();
}

// ---------------------------------------------------------------------------
// The rail, which is where the height ran out first.
// ---------------------------------------------------------------------------
for (const height of [900, 720, 640]) {
  const page = await browser.newPage({ viewport: { width: 1440, height } });
  await openProject(page, `A11y rail ${height} ${Date.now()}`);
  const rail = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Workspace panels"]');
    if (!nav) return null;
    const heights = [...nav.querySelectorAll('button')].map(
      (button) => button.getBoundingClientRect().height,
    );
    return { count: heights.length, min: Math.min(...heights) };
  });
  check(
    `desktop ${height}px tall · rail buttons >= ${MIN_TARGET}px`,
    rail !== null && rail.min >= MIN_TARGET,
    rail ? `${rail.count} buttons, smallest ${rail.min.toFixed(1)}px` : 'no rail found',
  );
  await page.close();
}

// ---------------------------------------------------------------------------
// Keyboard only: reaching and running a command without a pointer.
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openProject(page, `A11y keys ${Date.now()}`);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: /Command palette/i });
  check('palette opens from the keyboard', await palette.isVisible().catch(() => false));

  // Focus must land in the field, or the first keystroke goes nowhere.
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? '',
  );
  check('palette focuses its input', /Search commands/i.test(focused), focused);

  // No leading `>`: the palette opens in command mode with one already in the
  // field, and typing a second makes the search term itself start with it.
  await page.keyboard.type('profiler');
  await page.waitForTimeout(300);
  const options = page.getByRole('option');
  check('palette narrows by keyword', (await options.count()) > 0);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check(
    'keyboard selection actually opens the panel',
    (await page.locator('button[aria-label="Performance"][aria-pressed="true"]').count()) === 1,
  );

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('escape closes the palette', !(await palette.isVisible().catch(() => false)));

  // -------------------------------------------------------------------------
  // Focus has to be visible where the keyboard can go.
  //
  // The global rule draws a 2px accent ring on `:focus-visible`, and a
  // `outline-none` utility silently defeats it — the element still *matches*
  // `:focus-visible`, it just paints the ring transparent. That is invisible
  // in the source and invisible on screen, which is how the file tree ended up
  // keyboard-navigable with no way to see where you were.
  //
  // Tab is pressed rather than calling `.focus()`, because programmatic focus
  // does not reliably put a button into `:focus-visible` and a check that used
  // it would pass on a control that shows nothing to a real keyboard user.
  // -------------------------------------------------------------------------
  const invisibleFocus = async (max) => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const bad = [];
    for (let i = 0; i < max; i += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        if (!el.matches(':focus-visible')) return null;
        const style = getComputedStyle(el);
        // Transparent or absent outline, and nothing else standing in for it.
        const ringless =
          style.outlineStyle === 'none' ||
          style.outlineWidth === '0px' ||
          /rgba\(0, 0, 0, 0\)|transparent/.test(style.outlineColor);
        if (!ringless) return null;
        if (style.boxShadow !== 'none') return null;
        return `${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24) || el.tagName} [${el.getAttribute('role') ?? el.tagName}]`;
      });
      if (stop) bad.push(stop);
    }
    return [...new Set(bad)];
  };

  const ringless = await invisibleFocus(30);
  check(
    'every keyboard stop shows a focus ring',
    ringless.length === 0,
    ringless.slice(0, 5).join(' | '),
  );

  // The file tree specifically: it handles its own arrow keys, so focus moves
  // between rows without Tab and the ring is the only thing that reports it.
  //
  // The Explorer has to be brought back first — an earlier check opened the
  // Performance panel, and a tree that is not on screen has no rows to fail.
  await page.locator('button[aria-label="Explorer"]').click();
  await page.waitForTimeout(600);
  const treeRing = await page.evaluate(() => {
    const row = document.querySelector('[role="treeitem"]');
    if (!row) return 'no tree row';
    row.focus();
    const style = getComputedStyle(row);
    return /rgba\(0, 0, 0, 0\)|transparent/.test(style.outlineColor)
      ? `tree row outline is ${style.outlineColor}`
      : null;
  });
  check('file tree rows can show a focus ring', treeRing === null, treeRing ?? '');

  // Icon-only controls must say what they are.
  const unnamed = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href]')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const named =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent?.trim() ||
        el.querySelector('[aria-label]');
      if (!named) out.push(el.className.toString().slice(0, 60) || el.tagName);
    }
    return out;
  });
  check('every visible control has an accessible name', unnamed.length === 0, unnamed.slice(0, 5).join(' | '));

  await page.close();
}

await browser.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
