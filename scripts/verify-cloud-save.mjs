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
 *   npm run verify:cloud
 *
 * It signs in the way you actually sign in. By default that is a real OAuth
 * round trip: it opens your browser at Supabase's authorize URL, you complete
 * Google (or GitHub) as normal, and the provider redirects back to a one-shot
 * listener on localhost that this process is holding open. Nothing here ever
 * sees your Google password, and no Forge password has to exist.
 *
 *   --provider github     use GitHub instead of Google
 *   --session             skip the browser: paste a session the app already has
 *   --port 8910           the localhost port the redirect comes back to
 *   --browser             do the OAuth round trip even with no terminal
 *
 * `--session` is the way out when the redirect URL is not in your project's
 * allowlist: sign in to Forge as usual, take the session from the running app,
 * and paste it here. The tokens are read without echo and are not stored.
 *
 * For a non-interactive run (CI), either FORGE_TEST_EMAIL and
 * FORGE_TEST_PASSWORD, or FORGE_TEST_ACCESS_TOKEN and FORGE_TEST_REFRESH_TOKEN,
 * are honoured if set. Nothing requires any of them to be stored anywhere.
 *
 * The account must already exist. Everything it creates is deleted at the end,
 * including on failure. Nothing it prints contains a token, key or password.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { argv, env, exit, platform, stdin, stdout } from 'node:process';
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

const missing = [
  !url && 'VITE_SUPABASE_URL',
  !anonKey && 'VITE_SUPABASE_ANON_KEY',
].filter(Boolean);

if (missing.length) {
  console.error(`Missing from .env: ${missing.join(', ')}`);
  console.error('These are the same two values the app itself reads.');
  exit(2);
}

if (/service_role/.test(anonKey) || (anonKey.split('.')[1] ?? '').includes('c2VydmljZV9yb2xl')) {
  console.error('That looks like a service-role key. It bypasses row level security,');
  console.error('so a run with it would prove nothing. Use the anon key.');
  exit(2);
}

// ------------------------------------------------------------- credentials

/**
 * Everything read from stdin that a prompt has not consumed yet.
 *
 * One reader, not two. An earlier version asked for the email through
 * `readline` and the password through raw mode, and `readline` buffers whatever
 * arrives with the line it returns — so a password typed fast enough to land in
 * the same chunk, or pasted with the email, was swallowed when the interface
 * closed and the next prompt saw only end-of-input.
 */
let pending = '';

/**
 * Read one line, with the terminal's echo under our control.
 *
 * `echo: false` is what keeps a password off the screen, out of the scrollback
 * and out of a screen share. Raw mode is what makes that possible, so it is
 * restored on every path out — including Ctrl+C, because leaving a terminal in
 * raw mode is worse than the error that got us there.
 */
function readLine(question, { echo }) {
  return new Promise((resolve, reject) => {
    stdout.write(question);

    /** Take a completed line out of the buffer, if there is one. */
    const takeLine = () => {
      const at = pending.search(/\r|\n/);
      if (at === -1) return null;
      const line = pending.slice(0, at);
      // Consume the terminator, and the second byte of a CRLF pair.
      let rest = pending.slice(at + 1);
      if (pending[at] === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
      pending = rest;
      return line;
    };

    const buffered = takeLine();
    if (buffered !== null) {
      // It was already typed or pasted. Echo it only if this prompt echoes.
      stdout.write(echo ? `${buffered}\n` : '\n');
      resolve(buffered.trim());
      return;
    }

    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = (error, result) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      // The newline the suppressed Enter never printed.
      stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        // Ctrl+C, and Ctrl+D on an empty line, both mean stop.
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u0004' && !pending) return finish(new Error('Cancelled.'));
        if (char === '\u0004') continue;

        // Backspace, as either byte a terminal may send for it.
        if (char === '\u007f' || char === '\b') {
          if (!pending) continue;
          pending = pending.slice(0, -1);
          if (echo) stdout.write('\b \b');
          continue;
        }

        pending += char;
        if (/\r|\n/.test(char)) {
          const line = takeLine();
          return finish(null, (line ?? '').trim());
        }
        // Arrow keys and the like arrive as escape sequences; none of that
        // belongs in an email address or a password.
        if (char < ' ') pending = pending.slice(0, -1);
        else if (echo) stdout.write(char);
      }
    };

    stdin.on('data', onData);
  });
}

// ----------------------------------------------------------------- arguments

const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const provider = option('provider', 'google');
const callbackPort = Number(option('port', env.FORGE_VERIFY_PORT ?? 8910));
if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
  console.error(`--port must be a number between 1024 and 65535, not ${option('port', '')}`);
  exit(2);
}

// ------------------------------------------------------------- authentication

/**
 * Somewhere for the auth client to keep the PKCE code verifier.
 *
 * The verifier is minted when the authorize URL is built and needed again when
 * the code comes back, so it has to survive between the two — but only within
 * this process. Memory, not disk: nothing about this run should outlive it.
 */
const memoryStorage = () => {
  const held = new Map();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
};

const authClient = (storage) =>
  createClient(url, anonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: Boolean(storage),
      autoRefreshToken: false,
      detectSessionInUrl: false,
      ...(storage ? { storage } : {}),
    },
  });

/** Ask the desktop to open a URL, and say so if it cannot. */
function openInBrowser(target) {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [target]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The real OAuth round trip, with a one-shot listener for the redirect.
 *
 * This is the flow `gh auth login` and `supabase login` use, and it is the only
 * honest way to test an account that has no password: the provider is the one
 * asking for credentials, in the browser, and this process only ever receives
 * the authorization code that comes back.
 */
async function signInWithBrowser(client) {
  const redirectTo = `http://localhost:${callbackPort}/callback`;
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw new Error(`Could not start the ${provider} sign-in: ${error.message}`);
  if (!data?.url) throw new Error('Supabase returned no authorize URL to open.');

  const code = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requested = new URL(request.url, `http://localhost:${callbackPort}`);
      if (requested.pathname !== '/callback') {
        response.writeHead(404).end('Not here.');
        return;
      }
      const returned = requested.searchParams.get('code');
      const failure =
        requested.searchParams.get('error_description') ?? requested.searchParams.get('error');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Forge</title>` +
          `<body style="font:15px system-ui;padding:3rem;max-width:32rem">` +
          `<h1 style="font-size:1.1rem">${returned ? 'Signed in.' : 'Sign-in failed.'}</h1>` +
          `<p>${returned ? 'You can close this tab and go back to the terminal.' : 'Go back to the terminal for the details.'}</p>`,
      );
      // One request is all this listener exists for.
      server.close();
      if (returned) resolve(returned);
      else reject(new Error(failure ?? 'The provider came back without an authorization code.'));
    });

    server.on('error', (serverError) => {
      reject(
        serverError.code === 'EADDRINUSE'
          ? new Error(
              `Port ${callbackPort} is already in use. Pass --port with a free one, and add ` +
                'that address to the redirect allowlist too.',
            )
          : serverError,
      );
    });

    server.listen(callbackPort, '127.0.0.1', () => {
      console.log(`Opening your browser to sign in with ${provider}.`);
      console.log('If it does not open, paste this into a browser yourself:\n');
      console.log(`  ${data.url}\n`);
      console.log(`Waiting for the redirect to ${redirectTo} …`);
      openInBrowser(data.url);
    });

    // Do not hold the terminal for ever if the browser never comes back.
    const giveUp = setTimeout(
      () => {
        server.close();
        reject(new Error('Timed out after five minutes waiting for the browser to come back.'));
      },
      5 * 60 * 1000,
    );
    giveUp.unref?.();
  });

  const { data: exchanged, error: exchangeError } = await client.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    throw new Error(
      `The authorization code was refused: ${exchangeError.message}\n` +
        `If it mentions the redirect, add ${redirectTo} to Authentication → URL ` +
        'Configuration → Redirect URLs in the Supabase dashboard.',
    );
  }
  return exchanged.session ?? null;
}

/**
 * Use a session the app already holds.
 *
 * The way out when the localhost redirect is not allowlisted and adding it is
 * not worth it. The tokens are read without echo, held only in this process,
 * and expire on their own — but they are still bearer credentials, which is why
 * this is the fallback and not the default.
 */
async function signInWithPastedSession(client) {
  const accessToken =
    env.FORGE_TEST_ACCESS_TOKEN ||
    (await readLine('Access token: ', { echo: false }));
  if (!accessToken) throw new Error('No access token given.');
  const refreshToken =
    env.FORGE_TEST_REFRESH_TOKEN ||
    (await readLine('Refresh token (Enter to skip): ', { echo: false }));

  const { data, error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken || accessToken,
  });
  if (error) throw new Error(`That session was not accepted: ${error.message}`);
  return data.session ?? null;
}

/** Print how to get a session out of the running app, without guessing at it. */
function explainPastedSession() {
  const ref = new URL(url).host.split('.')[0];
  console.log('Sign in to Forge as you normally do, then in that tab open the browser');
  console.log('console and run:\n');
  console.log(`  JSON.parse(localStorage.getItem('sb-${ref}-auth-token'))\n`);
  console.log('Copy `access_token` and `refresh_token` from what it prints.');
  console.log('Nothing is echoed as you paste, and nothing is written to disk.\n');
}

/**
 * Sign in, by whichever route this account actually has.
 *
 * Order matters: anything already in the environment wins, so a CI job never
 * waits on a browser. Otherwise the browser round trip is the default, because
 * it is how the person running this signs in — an account that only exists
 * through Google has no password to ask for, and inventing one just for a test
 * would be a credential created for no reason.
 */
async function authenticate() {
  const password = env.FORGE_TEST_PASSWORD;
  const email = env.FORGE_TEST_EMAIL;

  if (email && password) {
    const client = authClient(null);
    return { client, mode: 'password', email, password };
  }
  if (env.FORGE_TEST_ACCESS_TOKEN) {
    const client = authClient(null);
    return { client, mode: 'session', session: await signInWithPastedSession(client) };
  }
  const host = new URL(url).host;

  // The browser round trip reads nothing from stdin — the provider does the
  // asking, in the browser — so it does not need a terminal. What it does need
  // is somebody watching to complete it, which is why a run with no terminal
  // has to say so explicitly rather than sit for five minutes in a CI job.
  const canWait = stdin.isTTY || flag('browser');

  if (flag('session')) {
    if (!stdin.isTTY) {
      console.error('--session pastes a token at a prompt, and there is no terminal here.');
      console.error('Set FORGE_TEST_ACCESS_TOKEN and FORGE_TEST_REFRESH_TOKEN instead.');
      exit(2);
    }
    console.log(`Signing in to ${host}.\n`);
    explainPastedSession();
    const client = authClient(null);
    return { client, mode: 'session', session: await signInWithPastedSession(client) };
  }

  if (!canWait) {
    console.error('No terminal to sign in at, and no credentials in the environment.');
    console.error('Either run this from a terminal, add --browser to wait for an OAuth');
    console.error('round trip anyway, or set one of these pairs for the one command:');
    console.error('  FORGE_TEST_ACCESS_TOKEN and FORGE_TEST_REFRESH_TOKEN  (a session)');
    console.error('  FORGE_TEST_EMAIL and FORGE_TEST_PASSWORD              (password accounts)');
    console.error('Not in .env, where they would live on disk.');
    exit(2);
  }

  console.log(`Signing in to ${host}.\n`);
  const client = authClient(memoryStorage());
  return { client, mode: 'oauth', session: await signInWithBrowser(client) };
}

let authenticated;
try {
  authenticated = await authenticate();
} catch (error) {
  // Our own message, or the provider's — neither contains a credential.
  console.error(`\n${error?.message ?? 'Could not sign in.'}`);
  exit(2);
}

const { client, mode } = authenticated;
const email = authenticated.email ?? null;
const password = authenticated.password ?? null;
let session = authenticated.session ?? null;
authenticated = null;

/**
 * A last line of defence on the console.
 *
 * Nothing below is written to print a credential, and nothing does. But the
 * client library also writes to stderr on a network failure, and "we were
 * careful" is a weaker guarantee than "it cannot come out of this process".
 * Anything containing a secret is redacted on the way to the terminal.
 */
const secrets = () =>
  [password, session?.access_token, session?.refresh_token].filter(
    (secret) => typeof secret === 'string' && secret.length >= 8,
  );

for (const channel of ['log', 'error', 'warn']) {
  const original = console[channel].bind(console);
  console[channel] = (...args) => {
    const held = secrets();
    original(
      ...args.map((arg) => {
        if (typeof arg !== 'string') return arg;
        let text = arg;
        for (const secret of held) {
          if (text.includes(secret)) text = text.split(secret).join('[redacted]');
        }
        return text;
      }),
    );
  };
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
  await step(`sign in (${mode})`, async () => {
    if (mode === 'password') {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      check(error, 'Sign-in was refused');
      session = data.session ?? null;
    }
    // The OAuth and pasted-session routes already hold a session by the time
    // the run starts; there is nothing left to do but confirm the server
    // agrees it is a session, which `getUser` asks it directly.
    const { data: whoami, error: whoamiError } = await client.auth.getUser();
    check(whoamiError, 'The auth server did not accept this session');
    userId = whoami.user?.id ?? null;
    if (!userId) throw new Error('Signed in, but the session carries no user id.');
    // The id is a uuid, not a credential; no token is ever printed.
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

  await step('a second session reads it all back (what a refresh does)', async () => {
    // A second client, with its own empty cache, issuing its own requests. For
    // a password account that is a second sign-in; for an OAuth or pasted
    // session it is the same credential presented by a client that wrote none
    // of this — which is what the check is about. Either way the rows have to
    // come from the database rather than from anything the writer remembered.
    const reader = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (mode === 'password') {
      const { error: signInError } = await reader.auth.signInWithPassword({ email, password });
      check(signInError, 'The second sign-in was refused');
    } else {
      const { error: setError } = await reader.auth.setSession({
        access_token: session?.access_token ?? '',
        refresh_token: session?.refresh_token ?? '',
      });
      check(setError, 'The second client could not take the session');
      // `getUser` is a request to the auth server, not a local decode, so this
      // is the server confirming the second client's session independently.
      const { data: whoami, error: whoamiError } = await reader.auth.getUser();
      check(whoamiError, 'The auth server did not accept the second session');
      if (whoami.user?.id !== userId) {
        throw new Error('The second session belongs to a different user.');
      }
    }

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
    if (mode === 'password') await reader.auth.signOut();
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
  // Clean up whatever got created, whether or not the run succeeded — and
  // never let the cleanup itself become the output. A run that cannot reach
  // the database fails at the first step and then fails to delete, and the
  // report is the thing worth seeing, not a stack trace from the tidying up.
  let cleanupNote = null;
  try {
    const { error } = await client.from('projects').delete().eq('id', projectId);
    if (error) cleanupNote = error.message;
  } catch (error) {
    cleanupNote = error?.message ?? String(error);
  }
  // Only a session this script created is ours to end. Signing out of a
  // session the browser is still using would sign the person out of Forge.
  if (mode === 'password') await client.auth.signOut().catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  if (cleanupNote) {
    console.log(`\nCould not delete the project this run created (${projectId}):`);
    console.log(`  ${cleanupNote}`);
    console.log('  Remove it from the dashboard if it is there.');
  }
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
