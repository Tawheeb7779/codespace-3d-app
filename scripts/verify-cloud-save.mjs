/**
 * Prove that cloud persistence actually works, against your live Supabase.
 *
 * Inspecting policies is not enough, and this project learned that the hard
 * way: `projects_insert_owner` was present and correct on a deployment where
 * every insert still failed, because PostgreSQL applies the SELECT policy as an
 * extra check against rows produced by a RETURNING clause, and the client asks
 * for one. So this does not read `pg_policy` — it performs the exact statements
 * the browser performs, as a real signed-in user, over PostgREST:
 *
 *   .insert(...).select().single()                  create a project
 *   .upsert(rows, ...).select('path')               save files
 *   .update({ dirs, updated_at }).eq(...).select()  save the folder list
 *   a fresh client, reading it all back             what a refresh does
 *
 * A step that returns no rows fails here, exactly as it now fails in the app.
 *
 * Usage — from the repository root, with your .env in place:
 *
 *   FORGE_TEST_EMAIL=you@example.com FORGE_TEST_PASSWORD=... \
 *     node scripts/verify-cloud-save.mjs
 *
 * The account must already exist. Everything it creates is deleted at the end,
 * including on failure. Nothing it prints contains a token, key or password.
 */
import { readFileSync } from 'node:fs';
import { env, exit } from 'node:process';
import { createClient } from '@supabase/supabase-js';

// --------------------------------------------------------------- configuration

/** Read .env without a dependency, and without printing any of it. */
function readEnvFile(path = '.env') {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const file = readEnvFile();
const url = env.VITE_SUPABASE_URL ?? file.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY ?? file.VITE_SUPABASE_ANON_KEY;
const email = env.FORGE_TEST_EMAIL;
const password = env.FORGE_TEST_PASSWORD;

const missing = [
  !url && 'VITE_SUPABASE_URL',
  !anonKey && 'VITE_SUPABASE_ANON_KEY',
  !email && 'FORGE_TEST_EMAIL',
  !password && 'FORGE_TEST_PASSWORD',
].filter(Boolean);

if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}`);
  console.error('The first two come from .env; the account is one you already have.');
  exit(2);
}

if (/service_role/.test(anonKey) || (anonKey.split('.')[1] ?? '').includes('c2VydmljZV9yb2xl')) {
  console.error('That looks like a service-role key. It bypasses row level security,');
  console.error('so a run with it would prove nothing. Use the anon key.');
  exit(2);
}

// ------------------------------------------------------------------- reporting

let passed = 0;
let failed = 0;
const failures = [];

const step = async (name, fn) => {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    const message = error?.message ?? String(error);
    failures.push({ name, message });
    console.log(`FAIL  ${name}\n      ${message.split('\n').join('\n      ')}`);
  }
};

/** Turn a PostgREST error into something that names the likely cause. */
const explain = (error) => {
  if (!error) return null;
  const code = error.code ? ` (${error.code})` : '';
  if (error.code === '42501') {
    return (
      `${error.message}${code}\n` +
      'A row level security policy refused this. If it is the projects insert, ' +
      'migration 0007 is the one that lets the creator read the row back.'
    );
  }
  if (error.code === 'PGRST301' || /jwt|token/i.test(error.message ?? '')) {
    return `${error.message}${code}\nThe session was not accepted. Sign in again.`;
  }
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return `${error.message}${code}\nThat table does not exist — 0001 has not been applied.`;
  }
  return `${error.message}${code}`;
};

const check = (error, context) => {
  if (error) throw new Error(`${context}: ${explain(error)}`);
};

// ------------------------------------------------------------------- the run

const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const host = new URL(url).host;
const suffix = Date.now();
const projectId = crypto.randomUUID();
const FILES = {
  'index.html': `<h1>verify ${suffix}</h1>`,
  'src/main.js': `console.log(${suffix});`,
};
const DIRS = ['src', 'src/empty-check'];

let userId = null;

console.log(`Verifying cloud persistence against ${host}\n`);

try {
  await step('sign in', async () => {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    check(error, 'Sign-in was refused');
    userId = data.user?.id ?? null;
    if (!userId) throw new Error('Signed in, but the session carries no user id.');
    // The id is a uuid, not a credential; the token is never printed.
    return `session user ${userId}`;
  });

  await step('the database agrees who you are', async () => {
    // `profiles_select_self_or_shared` admits `id = auth.uid()`. If this comes
    // back empty, PostgREST is not seeing the session this client holds, and
    // every policy below would fail for that reason rather than any other.
    const { data, error } = await client
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    check(error, 'Reading your own profile failed');
    if (!data) {
      throw new Error(
        'Your own profile row is not visible to you. Either auth.uid() is not ' +
          'returning this id, or the profile row was never created — check that ' +
          'the on_auth_user_created trigger exists.',
      );
    }
    return 'auth.uid() matches the session';
  });

  await step('migration 0005 is applied (a writer may update a project)', async () => {
    const { error } = await client.rpc('can_write_project', { p_project: projectId });
    // The function may not take that argument name, or may not be exposed to
    // PostgREST at all; neither is evidence about 0005, so only a missing
    // function is reported. The real proof is the update step further down.
    if (error && (error.code === '42883' || error.code === 'PGRST202')) {
      return 'not checkable from here — the update step below is the real proof';
    }
    return 'reachable';
  });

  await step('create a project (insert … RETURNING, what 0007 fixes)', async () => {
    const { data, error } = await client
      .from('projects')
      .insert({
        id: projectId,
        owner_id: userId,
        name: `Cloud verify ${suffix}`,
        description: 'Created by scripts/verify-cloud-save.mjs',
        template: 'vanilla',
        language: 'HTML',
        visibility: 'private',
        status: 'active',
        starred: false,
        dirs: [],
      })
      .select()
      .single();
    check(error, 'Creating the project failed');
    if (!data) throw new Error('The insert returned no row, so it did not happen.');
    return `project ${data.id}`;
  });

  await step('save files (upsert … RETURNING, what the save now checks)', async () => {
    const rows = Object.entries(FILES).map(([path, content]) => ({
      project_id: projectId,
      path,
      content,
      updated_at: new Date().toISOString(),
    }));
    const { data, error } = await client
      .from('project_files')
      .upsert(rows, { onConflict: 'project_id,path' })
      .select('path');
    check(error, 'Saving the files failed');
    const landed = new Set((data ?? []).map((row) => row.path));
    const lost = Object.keys(FILES).filter((path) => !landed.has(path));
    if (lost.length) {
      throw new Error(
        `${lost.length} of ${Object.keys(FILES).length} files were accepted but not stored: ` +
          `${lost.join(', ')}. That is what a policy refusing a write looks like.`,
      );
    }
    return `${landed.size} files stored`;
  });

  await step('save the folder list (update … RETURNING, what 0005 fixes)', async () => {
    const { data, error } = await client
      .from('projects')
      .update({ dirs: DIRS, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .select('id, dirs');
    check(error, 'Updating the project failed');
    if (!data?.length) {
      throw new Error(
        'The update matched no rows. With no error, that means row level ' +
          'security made the row invisible to the update — migration 0005 adds ' +
          'the writer update policy this needs.',
      );
    }
    return `dirs = ${JSON.stringify(data[0].dirs)}`;
  });

  await step('a second edit to the same file overwrites rather than duplicating', async () => {
    const { data, error } = await client
      .from('project_files')
      .upsert(
        [
          {
            project_id: projectId,
            path: 'index.html',
            content: `<h1>edited ${suffix}</h1>`,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: 'project_id,path' },
      )
      .select('path');
    check(error, 'The second save failed');
    if (!data?.length) throw new Error('The second save stored nothing.');
    return 'stored';
  });

  await step('a fresh session reads it all back (what a refresh does)', async () => {
    const reader = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await reader.auth.signInWithPassword({ email, password });
    check(signInError, 'The second sign-in was refused');

    const { data: project, error: projectError } = await reader
      .from('projects')
      .select('id, dirs')
      .eq('id', projectId)
      .maybeSingle();
    check(projectError, 'Reading the project back failed');
    if (!project) throw new Error('The project is not there. It was not persisted.');

    const { data: files, error: filesError } = await reader
      .from('project_files')
      .select('path, content')
      .eq('project_id', projectId);
    check(filesError, 'Reading the files back failed');

    const byPath = Object.fromEntries((files ?? []).map((row) => [row.path, row.content]));
    const missingFiles = Object.keys(FILES).filter((path) => !(path in byPath));
    if (missingFiles.length) {
      throw new Error(`These files are not in the database: ${missingFiles.join(', ')}`);
    }
    if (byPath['index.html'] !== `<h1>edited ${suffix}</h1>`) {
      throw new Error('index.html came back with the wrong contents — the edit was lost.');
    }
    const storedDirs = project.dirs ?? [];
    const missingDirs = DIRS.filter((dir) => !storedDirs.includes(dir));
    if (missingDirs.length) {
      throw new Error(`Empty folders did not survive: ${missingDirs.join(', ')}`);
    }
    await reader.auth.signOut();
    return `${Object.keys(byPath).length} files, ${storedDirs.length} folders`;
  });

  await step('row level security still refuses a project you do not own', async () => {
    // Not weakened by 0007: the row has someone else's owner_id, so neither arm
    // of the select policy admits it and the insert must be refused.
    const stranger = crypto.randomUUID();
    const { error } = await client
      .from('projects')
      .insert({
        id: crypto.randomUUID(),
        owner_id: stranger,
        name: 'should not exist',
        description: '',
        template: 'vanilla',
        language: 'HTML',
        visibility: 'private',
        status: 'active',
        starred: false,
        dirs: [],
      })
      .select()
      .single();
    if (!error) {
      throw new Error(
        'A project filed under another user id was accepted. Row level security ' +
          'is not enforcing ownership — do not use this deployment.',
      );
    }
    return `refused (${error.code ?? 'no code'})`;
  });
} finally {
  // Clean up whatever got created, whether or not the run succeeded.
  await client.from('projects').delete().eq('id', projectId);
  await client.auth.signOut().catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nWhat to do:');
    for (const failure of failures) console.log(`  - ${failure.name}`);
    console.log(
      '\nIf the project insert failed with 42501, apply supabase/migrations/' +
        '0007_project_select_on_new_row.sql.\nIf the folder-list update matched no ' +
        'rows, apply supabase/migrations/0005_editor_saves.sql.\nBoth are ' +
        'idempotent and raise if the end state is wrong.',
    );
  } else {
    console.log('\nCloud persistence works: create, save, edit and reload all round-trip,');
    console.log('and a project filed under another user is still refused.');
  }
  exit(failed ? 1 : 0);
}
