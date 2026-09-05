/**
 * Does the deployed schema actually have the columns the application uses?
 *
 * The RLS suite proves the *policies* are right. This proves something
 * different and equally able to break production: that every column the
 * repository code selects, inserts or filters on exists in the migrations.
 * A rename in a migration that misses one call site is invisible to
 * TypeScript — PostgREST only fails at runtime, against the real database, on
 * the one code path nobody exercised locally.
 *
 * The columns are declared here rather than parsed out of the client code:
 * a parser sophisticated enough to read every query shape would be a second
 * thing to get wrong, and this list is short enough to read.
 *
 *   node scripts/check-schema-conformance.mjs            # temporary database
 *   DATABASE_URL=postgres://… node scripts/check-schema-conformance.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DB = process.env.FORGE_SCHEMA_DB ?? 'forge_schema_check';
const url = process.env.DATABASE_URL;

/**
 * Every column the application depends on, by table.
 *
 * Sources: `src/lib/repo/supabaseRepository.ts`, `src/stores/githubStore.ts`
 * and the Edge Functions under `supabase/functions/`.
 */
const EXPECTED = {
  profiles: ['id', 'email', 'display_name'],
  projects: [
    'id',
    'owner_id',
    'name',
    'description',
    'template',
    'language',
    'visibility',
    'status',
    'starred',
    'dirs',
    'created_at',
    'updated_at',
  ],
  project_files: ['project_id', 'path', 'content', 'updated_at'],
  project_members: ['id', 'project_id', 'user_id', 'role', 'created_at'],
  project_vcs: ['project_id', 'snapshot', 'updated_at'],
  project_activity: ['id', 'project_id', 'actor_id', 'action', 'detail', 'created_at'],
  project_remotes: [
    'project_id',
    'provider',
    'owner',
    'repo',
    'repo_id',
    'default_branch',
    'branch',
    'last_fetched_sha',
    'last_synced_sha',
    'last_fetched_at',
    'tracking',
    'updated_at',
  ],
  workspaces: [
    'id',
    'owner_id',
    'name',
    'description',
    'project_ids',
    'pinned',
    'created_at',
    'updated_at',
    'opened_at',
  ],
  github_connections: [
    'user_id',
    'github_login',
    'github_user_id',
    'avatar_url',
    'scopes',
    'connected_at',
    'revoked_at',
  ],
};

/**
 * Tables that must live in `private`, not `public`.
 *
 * This is the GitHub credential boundary: the token and the OAuth state are
 * reachable only by the Edge Function's service role, because `private` has no
 * grants to any browser role. A migration that moved either of these into
 * `public` would hand every signed-in user a route to somebody else's token,
 * so their *location* is asserted, not just their columns.
 */
const PRIVATE_TABLES = {
  github_tokens: ['user_id', 'access_token', 'refresh_token', 'expires_at', 'updated_at'],
  github_oauth_states: ['state', 'user_id', 'redirect', 'created_at', 'expires_at'],
};

/** Tables that must have row level security switched on, without exception. */
const MUST_HAVE_RLS = [
  ...Object.keys(EXPECTED),
  'teams',
  'team_members',
  'project_settings',
];

const psql = (database, sql) =>
  execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql], {
    encoding: 'utf8',
  }).trim();

const psqlFile = (database, file) =>
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let target = url;
let temporary = false;

if (!target) {
  try {
    execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' });
  } catch {
    // Nothing to drop.
  }
  execFileSync('createdb', [DB], { stdio: 'inherit' });
  target = DB;
  temporary = true;
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`FAIL  ${message}`);
};
const pass = (message) => console.log(`ok    ${message}`);

try {
  psqlFile(target, join(ROOT, 'supabase/tests/00-bootstrap.sql'));
  const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const migration of migrations) {
    psqlFile(target, join(ROOT, 'supabase/migrations', migration));
  }
  pass(`${migrations.length} migrations applied in order: ${migrations.join(', ')}`);

  // Applying twice proves the migrations are idempotent, which is what makes
  // re-running them against an existing project safe.
  for (const migration of migrations) {
    psqlFile(target, join(ROOT, 'supabase/migrations', migration));
  }
  pass('migrations are idempotent — a second run is a no-op');

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const actual = new Set(
      psql(
        target,
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = '${table}'`,
      )
        .split('\n')
        .filter(Boolean),
    );
    if (!actual.size) {
      fail(`table public.${table} does not exist`);
      continue;
    }
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) fail(`public.${table} is missing: ${missing.join(', ')}`);
    else pass(`public.${table} has every column the application uses`);
  }

  for (const [table, columns] of Object.entries(PRIVATE_TABLES)) {
    const actual = new Set(
      psql(
        target,
        `select column_name from information_schema.columns
          where table_schema = 'private' and table_name = '${table}'`,
      )
        .split('\n')
        .filter(Boolean),
    );
    if (!actual.size) {
      fail(`table private.${table} does not exist`);
      continue;
    }
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) fail(`private.${table} is missing: ${missing.join(', ')}`);
    else pass(`private.${table} has every column the Edge Function uses`);

    // The same name must NOT also exist in public, where a browser could read it.
    const leaked = psql(
      target,
      `select count(*) from information_schema.tables
        where table_schema = 'public' and table_name = '${table}'`,
    );
    if (leaked !== '0') fail(`${table} also exists in public, where a browser role can reach it`);
    else pass(`${table} exists only in private`);
  }

  for (const table of MUST_HAVE_RLS) {
    const enabled = psql(
      target,
      `select relrowsecurity from pg_class
        where oid = 'public.${table}'::regclass`,
    );
    if (enabled === 't') pass(`public.${table} has row level security enabled`);
    else fail(`public.${table} does NOT have row level security enabled`);
  }

  // `anon` is the role an unauthenticated browser uses. It must reach nothing.
  const anonGrants = psql(
    target,
    `select table_name || ':' || privilege_type from information_schema.role_table_grants
      where grantee = 'anon' and table_schema in ('public', 'private')`,
  );
  if (anonGrants) fail(`anon has grants it should not: ${anonGrants.replace(/\n/g, ', ')}`);
  else pass('anon has no table privileges in public or private');

  // The token store must be unreachable from a user session at all.
  const privateGrants = psql(
    target,
    `select grantee || ':' || table_name from information_schema.role_table_grants
      where table_schema = 'private' and grantee in ('anon', 'authenticated')`,
  );
  if (privateGrants) fail(`the private schema is reachable: ${privateGrants}`);
  else pass('the private schema is unreachable from anon and authenticated');
} finally {
  if (temporary) {
    try {
      execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' });
    } catch {
      // Best effort.
    }
  }
}

console.log(failures ? `\n${failures} schema conformance failure(s)` : '\nschema conformance ok');
process.exit(failures ? 1 : 0);
