/**
 * Browser checks for the workspace polish pass.
 *
 * Everything here failed against the code as it was, or guards something that
 * only a real browser can decide: pointer capture across an iframe, whether a
 * tab that is scrolled out of view comes back, how a chord normalises, and
 * whether a control has a name a screen reader can read out.
 *
 *   node e2e/polish.mjs
 *
 * FORGE_E2E_CHROMIUM overrides the browser binary; FORGE_E2E_BASE the origin.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.FORGE_E2E_BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.FORGE_E2E_ARTIFACTS ?? 'e2e/artifacts';
mkdirSync(OUT, { recursive: true });
const CHROMIUM = process.env.FORGE_E2E_CHROMIUM;

const pageErrors = [];
let passed = 0;
let failed = 0;

const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${(error.message ?? String(error)).split('\n').slice(0, 3).join(' | ')}`);
    await page
      .screenshot({ path: `${OUT}/polish-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
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

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
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
    await page.getByLabel('Project name').fill(`Polish ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(2000);
  });

  // ------------------------------------------------------------- shortcuts

  await step('2. the palette opens on the chord other editors use', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+P');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('3. the bottom panel toggles on Ctrl+backtick', async () => {
    const terminal = page.locator('.xterm');
    const before = await terminal.isVisible().catch(() => false);
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(500);
    const after = await terminal.isVisible().catch(() => false);
    assert(after !== before, `the panel did not toggle (${before} -> ${after})`);
    // Put it back the way it was.
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(400);
  });

  // ------------------------------------------------------------------ tabs

  await step('4. a tab activated from quick open is scrolled into view', async () => {
    // Open enough files that the strip has to scroll.
    const openFile = async (name) => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+P');
      await page.getByRole('dialog', { name: 'Open file' }).waitFor({ timeout: 8000 });
      await page.getByLabel('Search files').fill(name);
      await page.waitForTimeout(300);
      await page.getByRole('option').first().click({ timeout: 8000 });
      await page.waitForTimeout(400);
    };
    for (const name of ['index.html', 'styles.css', 'main.js']) await openFile(name);

    // Force the strip narrow enough that the first tab is off screen.
    await page.evaluate(() => {
      const strip = document.querySelector('[role="tablist"][aria-label="Open editors"]');
      strip.style.maxWidth = '150px';
      strip.scrollLeft = strip.scrollWidth;
    });
    await page.waitForTimeout(200);

    await openFile('index.html');
    const visible = await page.evaluate(() => {
      const strip = document.querySelector('[role="tablist"][aria-label="Open editors"]');
      const tab = strip.querySelector('[aria-selected="true"]');
      if (!tab) return null;
      const s = strip.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return t.left >= s.left - 1 && t.right <= s.right + 1;
    });
    await page.evaluate(() => {
      const strip = document.querySelector('[role="tablist"][aria-label="Open editors"]');
      strip.style.maxWidth = '';
    });
    assert(visible === true, `the active tab was not brought into view (${visible})`);
  });

  await step('5. arrow keys walk the tab strip', async () => {
    const active = () =>
      page.evaluate(
        () =>
          document.querySelector('[role="tablist"][aria-label="Open editors"] [aria-selected="true"]')
            ?.dataset.tabPath ?? null,
      );
    await page
      .locator('[role="tablist"][aria-label="Open editors"] [role="tab"][aria-selected="true"]')
      .focus();
    const before = await active();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const after = await active();
    assert(before && after && before !== after, `ArrowRight did not move (${before} -> ${after})`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    assert((await active()) === before, 'ArrowLeft did not come back');
  });

  await step('6. "close saved" leaves the file with unsaved work open', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Make exactly one file dirty.
    await page.locator('.monaco-editor').first().click({ timeout: 15000 });
    await page.keyboard.type('/* dirty */');
    await page.waitForTimeout(300);
    const dirtyPath = await page.evaluate(
      () =>
        document.querySelector('[role="tablist"][aria-label="Open editors"] [aria-selected="true"]')
          ?.dataset.tabPath ?? null,
    );

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 8000 });
    await page.getByLabel('Search commands').fill('>Close saved');
    await page.waitForTimeout(300);
    await page.getByRole('option').filter({ hasText: 'Close saved' }).first().click();
    await page.waitForTimeout(600);

    const left = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tablist"][aria-label="Open editors"] [role="tab"]')].map(
        (tab) => tab.dataset.tabPath,
      ),
    );
    assert(left.length === 1, `expected one tab left, got ${JSON.stringify(left)}`);
    assert(left[0] === dirtyPath, `the wrong tab survived: ${left[0]} vs ${dirtyPath}`);
    // Put the file back so later steps start clean.
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(600);
  });

  // -------------------------------------------------------------- dividers

  await step('7. the preview divider drags across the preview iframe', async () => {
    const handle = page.getByRole('separator', { name: /resize preview/i }).first();
    if (!(await handle.isVisible().catch(() => false))) {
      throw new Error('the preview divider is not on screen');
    }
    const box = await handle.boundingBox();
    /** The pane the divider actually sizes, read from the layout store. */
    const width = () =>
      page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          try {
            const value = JSON.parse(localStorage.getItem(key));
            if (value?.state && 'previewWidth' in value.state) return value.state.previewWidth;
          } catch {
            /* not ours */
          }
        }
        // Before the first resize nothing is stored; the default is the width
        // the pane is rendered at.
        const frame = document.querySelector('iframe[title="Project preview"]');
        return frame ? frame.getBoundingClientRect().width : 0;
      });

    // Run the preview first, so the iframe really is in the way.
    await page.getByRole('button', { name: /run the project/i }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const before = await width();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Drag left, straight over the preview frame.
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(box.x + box.width / 2 - i * 8, box.y + box.height / 2);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await width();
    assert(after - before > 60, `the divider stalled: ${before.toFixed(0)}px -> ${after.toFixed(0)}px`);
  });

  await step('8. the divider gives up when the button is released off-window', async () => {
    const handle = page.getByRole('separator', { name: /resize sidebar/i }).first();
    const box = await handle.boundingBox();
    const width = () =>
      page.evaluate(() => document.querySelector('aside')?.getBoundingClientRect().width ?? 0);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    const held = await width();
    // A move with no button held is what arrives after releasing off-window.
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 900, clientY: 400, buttons: 0, bubbles: true }),
      );
    });
    await page.mouse.move(box.x + 300, box.y + box.height / 2);
    await page.waitForTimeout(200);
    const after = await width();
    await page.mouse.up();
    assert(
      Math.abs(after - held) < 4,
      `the divider kept resizing with nothing held: ${held.toFixed(0)}px -> ${after.toFixed(0)}px`,
    );
    assert((await page.evaluate(() => document.body.style.cursor)) === '', 'the cursor was left set');
  });

  // ------------------------------------------------- reconciliation, again

  await step('9. the workspace survives a translator rewriting it throughout', async () => {
    const before = pageErrors.length;
    await page.evaluate(() => {
      window.__rewrites = 0;
      window.__rewriter = setInterval(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim()) nodes.push(walker.currentNode);
        }
        for (const node of nodes) {
          const font = document.createElement('font');
          font.textContent = node.textContent;
          node.parentNode?.replaceChild(font, node);
          window.__rewrites += 1;
        }
      }, 40);
    });

    // Everything the audit named, driven while the rewriter runs.
    await page.getByRole('button', { name: 'Source control', exact: true }).click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Activity', exact: true }).click().catch(() => {});
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Members', exact: true }).click().catch(() => {});
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Explorer', exact: true }).click().catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /stop the preview/i }).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /run the project/i }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator('.monaco-editor').first().click().catch(() => {});
    await page.keyboard.type('// churn');
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(900);

    const rewrites = await page.evaluate(() => {
      clearInterval(window.__rewriter);
      return window.__rewrites;
    });
    const introduced = pageErrors.slice(before);
    const reconciliation = introduced.filter((e) =>
      /removeChild|insertBefore|NotFoundError|not a child/.test(e),
    );
    assert(rewrites > 500, `the rewriter barely ran (${rewrites} nodes)`);
    assert(
      reconciliation.length === 0,
      `${reconciliation.length} reconciliation errors after ${rewrites} rewrites: ${reconciliation[0]}`,
    );
    console.log(`      ${rewrites} text nodes replaced, no reconciliation errors`);
  });

  // --------------------------------------------------------- accessibility

  await step('10. every interactive control has a name a screen reader can read', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await skipOnboarding();
    await page.waitForTimeout(1500);

    const nameless = await page.evaluate(() => {
      const named = (el) => {
        if (el.getAttribute('aria-label')?.trim()) return true;
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy && labelledBy.split(/\s+/).some((id) => document.getElementById(id))) return true;
        if (el.getAttribute('title')?.trim()) return true;
        if (el.textContent?.trim()) return true;
        // An icon-only control may name itself through an image's alt text.
        return [...el.querySelectorAll('img[alt], svg title')].some((n) =>
          (n.getAttribute('alt') ?? n.textContent ?? '').trim(),
        );
      };
      const inMonaco = (el) => el.closest('.monaco-editor, .xterm') !== null;
      return [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"]')]
        .filter((el) => !inMonaco(el) && el.offsetParent !== null && !named(el))
        .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)}`);
    });

    assert(nameless.length === 0, `${nameless.length} unnamed: ${nameless.slice(0, 5).join(' | ')}`);
  });

  await step('11. the mobile layout has no horizontal page overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert(
      overflow.scroll <= overflow.client + 1,
      `the page scrolls sideways: ${overflow.scroll} > ${overflow.client}`,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
  });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('--- page errors ---');
  console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');
  await browser.close();
  process.exit(failed ? 1 : 0);
}
