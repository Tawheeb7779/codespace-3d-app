/**
 * Browser end-to-end for the production-integration surfaces.
 *
 * Covers the parts that are verifiable without a live Supabase project: that
 * Local Mode is honest about what it is, that the invitation flow refuses
 * every invalid token for the right reason, and that no credential-shaped
 * value reaches browser storage.
 *
 * What this suite deliberately does NOT do is claim a cloud integration
 * works. Redeeming a real invitation needs a real Supabase project, and the
 * assertions here stop exactly where that begins.
 *
 *   node e2e/integration.mjs
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

const MONACO_DISPOSE = /^Canceled: Canceled$/m;
const FROM_PREVIEW = /about:srcdoc/;
page.on('pageerror', (e) => {
  const text = e.stack || e.message;
  if (MONACO_DISPOSE.test(e.message) && text.includes('monaco-editor')) return;
  if (FROM_PREVIEW.test(text)) return;
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
      .screenshot({ path: `${OUT}/integration-fail-${name.replace(/\W+/g, '-').slice(0, 55)}.png` })
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

const signIn = async () => {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  // An already-signed-in visitor is bounced to the dashboard, and the button
  // can be visible for the instant before that happens — so a click here is
  // allowed to lose the race with the redirect.
  const local = page.getByRole('button', { name: /Continue in Local Mode/i });
  if (await local.isVisible().catch(() => false)) {
    await local.click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL('**/dashboard', { timeout: 30000 });
  }
  await page.getByRole('button', { name: /New project/i }).first().waitFor({ timeout: 20000 });
};

try {
  // --------------------------------------------------- mode is stated truthfully

  await step('1. the sign-in page says why it is offering local mode', async () => {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    if (!/local/i.test(body)) throw new Error('local mode is not mentioned at all');
    // The reason must be named, not just the mode.
    if (!/VITE_SUPABASE_URL|not configured|not set/i.test(body)) {
      throw new Error(`the reason for local mode is not given: ${body.slice(0, 400)}`);
    }
  });

  await step('2. the dashboard labels the mode rather than implying cloud', async () => {
    await signIn();
    const body = await page.locator('body').innerText();
    if (!/Local Mode/i.test(body)) throw new Error('the dashboard does not label local mode');
    if (/\bCloud\b/.test(body)) throw new Error('the dashboard claims cloud mode with no backend');
  });

  await step('3. nothing credential-shaped is in browser storage', async () => {
    const stored = await page.evaluate(() => {
      const dump = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        dump.push(`${key}=${localStorage.getItem(key)}`);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        dump.push(`${key}=${sessionStorage.getItem(key)}`);
      }
      return dump.join('\n');
    });
    for (const pattern of [
      /gh[pousr]_[A-Za-z0-9]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /sk-[A-Za-z0-9-]{20,}/,
      /service_role/,
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./,
    ]) {
      if (pattern.test(stored)) throw new Error(`browser storage holds ${pattern}`);
    }
  });

  // ------------------------------------------------------------ invitations

  await step('4. local mode refuses to invite, and says why', async () => {
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    await page.getByLabel('Project name').fill(`Integration ${Date.now()}`);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await skipOnboarding();

    const members = page.getByRole('button', { name: 'Members', exact: true });
    if ((await members.getAttribute('aria-pressed')) !== 'true') await members.click();
    await page.waitForTimeout(900);

    const text = await page.locator('aside').first().innerText();
    if (!/Supabase/.test(text)) {
      throw new Error(`the panel does not explain why inviting is unavailable: ${text.slice(0, 300)}`);
    }
    const invite = page.getByRole('button', { name: 'Invite someone' });
    if (await invite.isEnabled().catch(() => false)) {
      throw new Error('the invite control is enabled with no backend to deliver one');
    }
  });

  await step('5. a malformed invitation link is refused, not accepted', async () => {
    await page.goto(`${BASE}/invite#not-a-real-token`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    if (!/cannot be used|not valid/i.test(body)) {
      throw new Error(`a malformed token was not refused: ${body.slice(0, 300)}`);
    }
  });

  await step('6. a well-formed but unknown token still fails honestly', async () => {
    await page.goto(`${BASE}/invite#${'a'.repeat(64)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    // In local mode there is no invitation store at all, so this must report a
    // failure — never a success, and never a silent redirect into a project.
    if (/You're in|Opening the project/i.test(body)) {
      throw new Error('an unknown token appeared to succeed');
    }
    if (!/cannot be used|Sign in to accept/i.test(body)) {
      throw new Error(`no honest outcome shown: ${body.slice(0, 300)}`);
    }
  });

  await step('7. the token never reaches the query string or the page title', async () => {
    const url = page.url();
    if (url.includes('?')) throw new Error(`the token leaked into a query string: ${url}`);
    const title = await page.title();
    if (title.includes('a'.repeat(64))) throw new Error('the token leaked into the page title');
  });

  await step('8. the invite route is reachable without a session', async () => {
    // An invitee arrives signed out. Bouncing them to a login page that drops
    // the fragment would silently destroy the token.
    const fresh = await browser.newContext();
    const anon = await fresh.newPage();
    await anon.goto(`${BASE}/invite#${'b'.repeat(64)}`, { waitUntil: 'domcontentloaded' });
    await anon.waitForTimeout(2500);
    const url = anon.url();
    if (!url.includes('/invite')) throw new Error(`an invitee was redirected away: ${url}`);
    const body = await anon.locator('body').innerText();
    if (!/Sign in to accept|cannot be used/i.test(body)) {
      throw new Error(`no guidance for a signed-out invitee: ${body.slice(0, 250)}`);
    }
    await fresh.close();
  });

  // ------------------------------------------------------- degraded states

  await step('9. GitHub reports its real availability, not a fake connection', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Integrations', exact: true }).click();
    await page.waitForTimeout(1200);
    const body = await page.locator('body').innerText();
    if (/\bConnected\b/.test(body) && !/Not connected/i.test(body)) {
      throw new Error('GitHub claims to be connected with no credential');
    }
  });

  await step('10. the app still works end to end in local mode', async () => {
    await signIn();
    await page.getByRole('button', { name: /New project/i }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Vanilla HTML/CSS/JS', exact: true }).click();
    const name = `Local ${Date.now()}`;
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: /Create project/i }).click();
    await page.waitForURL('**/project/**', { timeout: 40000 });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await skipOnboarding();

    // Persistence is real: reload and the project is still there.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    if (!(await page.locator('body').innerText()).includes(name)) {
      throw new Error('the project did not survive a reload in local mode');
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
