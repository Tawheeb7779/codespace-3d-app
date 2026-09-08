#!/usr/bin/env node
/**
 * The server's secrets must not be reachable from the browser.
 *
 * TA CODE holds one Gemini key for every user, in a Supabase Edge Function.
 * The whole value of that arrangement rests on a property that is one careless
 * line from being lost: `VITE_`-prefixed values are inlined by Vite into
 * JavaScript that every visitor downloads, so a rename from `GEMINI_API_KEY` to
 * `VITE_GEMINI_API_KEY` would publish the key with no error, no warning, and no
 * visible change.
 *
 * So this fails the build on the mistake rather than trusting a review to catch
 * it, and it checks the built output too, where a key that reached the client
 * by any route at all would end up.
 *
 *   npm run audit:secrets
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];
const note = (message) => failures.push(message);

/** Directories whose contents are not ours to police. */
const SKIP = new Set(['node_modules', '.git', 'coverage', 'e2e/artifacts']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (SKIP.has(entry) || SKIP.has(rel)) continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|html|css|yml|yaml|example|sh)$/;

// ---------------------------------------------------------------------------
// 1. No server secret may ever wear a client prefix.
// ---------------------------------------------------------------------------

/**
 * Names that must never be exposed to the browser. Matched with the `VITE_`
 * prefix, so the honest server-side spelling is untouched — the point is to
 * catch the rename, not to ban the variable.
 */
const SERVER_ONLY = ['GEMINI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_CLIENT_SECRET'];

for (const file of walk(ROOT)) {
  if (!TEXT.test(file)) continue;
  const rel = relative(ROOT, file);
  // This file names the forbidden spellings in order to forbid them.
  if (rel === 'scripts/audit-secrets.mjs') continue;
  const source = readFileSync(file, 'utf8');
  for (const name of SERVER_ONLY) {
    if (source.includes(`VITE_${name}`)) {
      note(`${rel} mentions VITE_${name}. Anything VITE_ prefixed ships to every visitor.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The server's secret must not be read from client code.
// ---------------------------------------------------------------------------

for (const file of walk(join(ROOT, 'src'))) {
  if (!TEXT.test(file)) continue;
  const source = readFileSync(file, 'utf8');
  if (/GEMINI_API_KEY/.test(source)) {
    note(`${relative(ROOT, file)} names GEMINI_API_KEY. That variable exists only on the server.`);
  }
  if (/import\.meta\.env\.\w*SERVICE_ROLE/i.test(source)) {
    note(`${relative(ROOT, file)} reads a service-role value from the client environment.`);
  }
}

// ---------------------------------------------------------------------------
// 3. Nothing credential-shaped may be committed.
// ---------------------------------------------------------------------------

const CREDENTIAL_SHAPES = [
  [/AIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/sk-[A-Za-z0-9]{32,}/, 'an OpenAI-style key'],
  [/sk-ant-[A-Za-z0-9-]{20,}/, 'an Anthropic key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
];

for (const file of walk(ROOT)) {
  if (!TEXT.test(file)) continue;
  const rel = relative(ROOT, file);
  if (rel === 'scripts/audit-secrets.mjs') continue;
  const source = readFileSync(file, 'utf8');
  for (const [shape, what] of CREDENTIAL_SHAPES) {
    if (shape.test(source)) note(`${rel} contains something shaped like ${what}.`);
  }
}

// ---------------------------------------------------------------------------
// 4. The built client, if there is one, must be clean too.
// ---------------------------------------------------------------------------

let checkedBundle = 0;
try {
  for (const file of walk(join(ROOT, 'dist'))) {
    if (!/\.(js|css|html|map)$/.test(file)) continue;
    checkedBundle += 1;
    const source = readFileSync(file, 'utf8');
    if (source.includes('GEMINI_API_KEY')) {
      note(`${relative(ROOT, file)} names GEMINI_API_KEY in the built client.`);
    }
    for (const [shape, what] of CREDENTIAL_SHAPES) {
      if (shape.test(source)) note(`${relative(ROOT, file)} contains something shaped like ${what}.`);
    }
  }
} catch {
  // No build yet. `npm run verify` builds after this runs, and a release build
  // is audited by re-running the script; saying so is better than silence.
}

if (failures.length) {
  console.error('\nsecret audit failed:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('');
  process.exit(1);
}

console.log(
  `no server secret reachable from the client` +
    (checkedBundle ? ` (${checkedBundle} built file${checkedBundle === 1 ? '' : 's'} checked)` : ' (no build present)'),
);
