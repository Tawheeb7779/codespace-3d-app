import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { startStubSupabase, STUB_USER_ID, type StubOptions, type StubSupabase } from './stubSupabase';

/**
 * The OAuth round trip, driven all the way through.
 *
 * An account that only exists through Google has no password, so the browser
 * flow is the path that account will actually take — and it is the part of the
 * verify script that cannot be exercised against a real project from a test.
 * So a stub stands in for Supabase: it answers the authorize redirect, the PKCE
 * token exchange and the PostgREST verbs, and records what it was asked for.
 *
 * The script prints its authorize URL before it waits. Fetching that URL is
 * what a person clicking through Google amounts to, from this side: the stub
 * redirects to the localhost listener the script is holding open, the code
 * comes back, and the run proceeds. Nothing here weakens what is being tested —
 * the statements the script sends are the same ones, and the stub asserts them.
 */

let stub: StubSupabase | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** A free port for the OAuth redirect, chosen per test so they can run at all. */
const port = () => 20000 + Math.floor(Math.random() * 20000);

interface RunResult {
  code: number | null;
  output: string;
}

/**
 * Run the script against the stub, completing the browser step for it.
 *
 * `--browser` is what lets the round trip run with no terminal attached; the
 * flow itself reads nothing from stdin, which is the whole reason it suits an
 * account that has no password.
 */
async function runOauth(options: StubOptions = {}, extraArgs: string[] = []): Promise<RunResult> {
  stub = await startStubSupabase(options);
  const redirectPort = port();

  const child = spawn(
    'node',
    ['scripts/verify-cloud-save.mjs', '--browser', '--port', String(redirectPort), ...extraArgs],
    {
      env: {
        PATH: process.env.PATH ?? '',
        VITE_SUPABASE_URL: stub.url,
        VITE_SUPABASE_ANON_KEY: stub.anonKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  let visited = false;

  const onChunk = (chunk: Buffer) => {
    output += chunk.toString();
    // As soon as the script has printed where to go, go there.
    const found = /(http:\/\/127\.0\.0\.1:\d+\/auth\/v1\/authorize\S*)/.exec(output);
    if (found && !visited) {
      visited = true;
      void fetch(found[1], { redirect: 'follow' }).catch(() => {});
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the script did not finish; output so far:\n${output}`));
    }, 30_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  return { code, output };
}

describe('signing in through the browser', () => {
  it('completes the round trip and runs every check', async () => {
    const { code, output } = await runOauth();

    expect(output).toMatch(/Opening your browser to sign in with google/);
    expect(output).toMatch(new RegExp(`session user ${STUB_USER_ID}`));
    expect(output).toMatch(/PASS {2}sign in \(oauth\)/);
    expect(output).toMatch(/PASS {2}the database agrees who you are/);
    expect(output).toMatch(/PASS {2}create a project/);
    expect(output).toMatch(/PASS {2}save files/);
    expect(output).toMatch(/PASS {2}save the folder list/);
    expect(output).toMatch(/PASS {2}a second session reads it all back/);
    expect(output).toMatch(/PASS {2}row level security still refuses a project you do not own/);
    expect(output).toMatch(/0 failed/);
    expect(code).toBe(0);
  });

  it('sends the statements the browser sends, in the shapes that matter', async () => {
    await runOauth();
    const requests = stub!.requests;

    const insert = requests.find((r) => r.method === 'POST' && r.path === '/rest/v1/projects');
    const upsert = requests.find((r) => r.method === 'POST' && r.path === '/rest/v1/project_files');
    const update = requests.find((r) => r.method === 'PATCH' && r.path === '/rest/v1/projects');

    // Each one asks for a representation back — the RETURNING clause that made
    // this whole class of failure invisible until it was checked.
    expect(insert?.query).toMatch(/select=/);
    expect(upsert?.query).toMatch(/select=path/);
    expect(update?.query).toMatch(/select=/);
    // And the upsert really is an upsert, not a plain insert.
    expect(String(upsert?.query)).toMatch(/on_conflict=project_id%2Cpath|on_conflict=project_id,path/);
  });

  it('deletes the project it created, even though the run passed', async () => {
    await runOauth();

    expect(stub!.requests.some((r) => r.method === 'DELETE' && r.path === '/rest/v1/projects')).toBe(
      true,
    );
    expect(stub!.projects.size).toBe(0);
  });

  it('does not sign the person out of the session their browser is using', async () => {
    await runOauth();

    expect(stub!.requests.some((r) => r.path === '/auth/v1/logout')).toBe(false);
  });
});

describe('using a session the app already has', () => {
  /**
   * The way out when the localhost redirect is not in the project's allowlist:
   * take the session out of the running app and hand it over. Non-interactively
   * that is the two environment variables; interactively it is the same two
   * read at a prompt without echo.
   */
  async function runWithSession(): Promise<RunResult> {
    stub = await startStubSupabase();
    const child = spawn('node', ['scripts/verify-cloud-save.mjs'], {
      env: {
        PATH: process.env.PATH ?? '',
        VITE_SUPABASE_URL: stub.url,
        VITE_SUPABASE_ANON_KEY: stub.anonKey,
        FORGE_TEST_ACCESS_TOKEN: stub.anonKey,
        FORGE_TEST_REFRESH_TOKEN: 'a-refresh-token-that-must-not-appear',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the script did not finish; output so far:\n${output}`));
      }, 30_000);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, output };
  }

  it('runs every check against that session', async () => {
    const { code, output } = await runWithSession();

    expect(output).toMatch(/PASS {2}sign in \(session\)/);
    expect(output).toMatch(/PASS {2}a second session reads it all back/);
    expect(output).toMatch(/0 failed/);
    expect(code).toBe(0);
  });

  it('never prints the tokens it was given', async () => {
    const { output } = await runWithSession();

    expect(output).not.toContain('a-refresh-token-that-must-not-appear');
  });

  it('leaves that session usable, rather than signing it out', async () => {
    await runWithSession();

    expect(stub!.requests.some((r) => r.path === '/auth/v1/logout')).toBe(false);
  });
});

describe('what each unapplied migration looks like', () => {
  it('names 0007 when the project insert is refused', async () => {
    const { code, output } = await runOauth({ refuseProjectInsert: true });

    expect(output).toMatch(/FAIL {2}create a project/);
    expect(output).toMatch(/0007_project_select_on_new_row\.sql/);
    expect(code).toBe(1);
  });

  it('names 0005 when the folder-list update matches nothing', async () => {
    const { code, output } = await runOauth({ refuseProjectUpdate: true });

    expect(output).toMatch(/FAIL {2}save the folder list/);
    expect(output).toMatch(/matched no rows/);
    expect(output).toMatch(/0005_editor_saves\.sql/);
    expect(code).toBe(1);
  });
});

describe('a write the database accepts but does not store', () => {
  it('fails, and names the files that did not land', async () => {
    const { code, output } = await runOauth({ swallowFileUpsert: true });

    expect(output).toMatch(/FAIL {2}save files/);
    expect(output).toMatch(/index\.html/);
    expect(output).toMatch(/src\/main\.js/);
    expect(code).toBe(1);
  });
});

describe('the check that the fix did not open anything', () => {
  it('fails loudly if a project filed under another user is accepted', async () => {
    const { code, output } = await runOauth({ allowForeignProject: true });

    expect(output).toMatch(/FAIL {2}row level security still refuses a project you do not own/);
    expect(output).toMatch(/is not enforcing ownership/i);
    expect(code).toBe(1);
  });
});
