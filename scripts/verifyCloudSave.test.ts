import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * How `verify:cloud` behaves before it reaches the network.
 *
 * The account is asked for at a prompt now, rather than read from `.env`, and
 * the paths that matter here are the ones that must not hang, must not ask for
 * a password where nothing can hide it, and must refuse a key that would make
 * the whole run meaningless.
 *
 * Every case below runs with a pipe for stdin — no terminal — which is also the
 * shape a CI job has. The interactive prompt itself needs a pty and is verified
 * separately; what is pinned here is that the script never waits for input it
 * cannot read.
 */

const run = promisify(execFile);

/** A well-formed anon key: `{"role":"anon"}` as the payload. */
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature';
/** The same shape, but `{"role":"service_role"}`. */
const SERVICE_ROLE = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature';

async function verify(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run('node', ['scripts/verify-cloud-save.mjs'], {
      // An empty stdin that is closed: no terminal, and no input to wait for.
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 20_000,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (failure.killed) throw new Error('the script hung waiting for input');
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('before it can run at all', () => {
  it('names the Supabase settings it needs, and asks for nothing else', async () => {
    const { code, output } = await verify({});

    expect(code).toBe(2);
    expect(output).toContain('VITE_SUPABASE_URL');
    expect(output).toContain('VITE_SUPABASE_ANON_KEY');
    // The account is not something .env should be carrying.
    expect(output).not.toContain('FORGE_TEST_PASSWORD is missing');
  });

  it('refuses a service-role key, which would bypass what is being tested', async () => {
    const { code, output } = await verify({
      VITE_SUPABASE_URL: 'https://demo.supabase.co',
      VITE_SUPABASE_ANON_KEY: SERVICE_ROLE,
    });

    expect(code).toBe(2);
    expect(output).toMatch(/service-role key/i);
    expect(output).toMatch(/row level security/i);
  });
});

describe('with no terminal to ask at', () => {
  it('says so and stops, rather than blocking on input it cannot read', async () => {
    const { code, output } = await verify({
      VITE_SUPABASE_URL: 'https://demo.supabase.co',
      VITE_SUPABASE_ANON_KEY: ANON,
    });

    expect(code).toBe(2);
    expect(output).toMatch(/No terminal/i);
    expect(output).toMatch(/FORGE_TEST_EMAIL and FORGE_TEST_PASSWORD/);
    // And it should say why not to put them in .env.
    expect(output).toMatch(/on disk/i);
  });

  it('accepts credentials from the environment, for a CI run', async () => {
    const { output } = await verify({
      VITE_SUPABASE_URL: 'https://demo.invalid',
      VITE_SUPABASE_ANON_KEY: ANON,
      FORGE_TEST_EMAIL: 'ci@example.com',
      FORGE_TEST_PASSWORD: 'a-password-that-must-not-appear',
    });

    // It got past the credentials and tried the database, which is as far as
    // it can get here: the host does not resolve.
    expect(output).toMatch(/Verifying cloud persistence/);
    expect(output).toMatch(/FAIL {2}sign in/);
    // The whole point: not in the banner, not in a step name, not in an error.
    expect(output).not.toContain('a-password-that-must-not-appear');
  });
});
