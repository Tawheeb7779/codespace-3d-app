import { readFile } from 'node:fs/promises';
import { resolveInWorkspaceNoSymlinks } from './workspace.ts';
import type { ContainerRecord } from './lifecycle.ts';
import type { ContainerRuntime } from './runtime/types.ts';
import { GatewayError } from './errors.ts';

/**
 * Running a project's own checks, for the agent to verify itself with.
 *
 * The agent can already edit files and read diagnostics from the in-browser
 * bundler. What it could not do is run the project's *real* checks — `npm test`
 * in a real Node, with the project's real dependencies — which is the
 * difference between "the bundler parsed it" and "the tests pass".
 *
 * **This is not a shell.** The agent names a script; it never supplies a
 * command line, an argument vector, or a flag. The same decision as `git.ts`,
 * for the same reason: a subcommand allowlist is an illusion when the caller
 * controls the options.
 *
 * What the container then runs is whatever the project's `package.json` defines
 * for that script, and that is deliberate rather than a gap. The container is
 * the sandbox: non-root, no capabilities, read-only root, no network, bounded
 * CPU, memory and pids. The user's own code already runs there whenever they
 * type in the terminal. Running their own test script is not an escalation —
 * it is the thing the workspace exists for. What is bounded here is the shape
 * of the request, the time it may take, and how much output can come back.
 */

/**
 * Script names the agent may run.
 *
 * A conservative list rather than "any script in package.json", because a
 * script is a name a project chooses and `deploy`, `publish` or `release` are
 * names projects choose too. These five are the ones that answer "did I break
 * anything", which is the only question the agent is asking.
 *
 * An operator who wants more adds them here, in review, rather than the agent
 * discovering them at runtime.
 */
export const CHECK_SCRIPTS: readonly string[] = [
  'test',
  'lint',
  'typecheck',
  'build',
  'verify',
];

/** How long a check may run. Long enough for a real suite, short enough to bound. */
const CHECK_TIMEOUT_MS = 180_000;
/** Output kept. A failing suite's first screens are what matters, not its last. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface CheckResult {
  script: string;
  /** True when the script exited zero. */
  ok: boolean;
  exitCode: number;
  /** Combined stdout and stderr, truncated with a marker rather than silently. */
  output: string;
  truncated: boolean;
}

export interface CheckRunner {
  runtime: ContainerRuntime;
  record: ContainerRecord;
}

/**
 * Which of the allowed checks this project actually defines.
 *
 * Read from the workspace's own `package.json`, through the symlink-refusing
 * resolver — a `package.json` that is a link to somewhere else is not this
 * project's manifest.
 *
 * Returning the intersection rather than the whole list is what lets the agent
 * say "this project has no test script" instead of running one and reporting a
 * confusing npm error.
 */
export async function availableChecks(record: ContainerRecord): Promise<string[]> {
  const manifestPath = await resolveInWorkspaceNoSymlinks(record.workspaceDir, 'package.json').catch(
    () => null,
  );
  if (!manifestPath) return [];

  const raw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (raw === null) return [];
  // A manifest larger than this is not a manifest.
  if (raw.length > 512 * 1024) return [];

  let parsed: { scripts?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }

  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  return CHECK_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
}

/**
 * Run one of the project's checks and report what happened.
 *
 * Never throws for a failing check — a failing test suite is a *result*, and
 * the agent needs to read it. It throws only when the request itself is not
 * something that can be run.
 */
export async function runCheck(runner: CheckRunner, script: string): Promise<CheckResult> {
  if (!CHECK_SCRIPTS.includes(script)) {
    throw new GatewayError(
      'CHECK_ERROR',
      `"${script}" is not a check this workspace will run.`,
      `script not in the allowlist: ${String(script).slice(0, 40)}`,
    );
  }

  const available = await availableChecks(runner.record);
  if (!available.includes(script)) {
    throw new GatewayError(
      'CHECK_ERROR',
      `This project does not define an "${script}" script.`,
      'script absent from package.json',
    );
  }

  // `npm run <script>` with the name as its own argument. The name is one of
  // five constants by this point, so there is nothing here for a caller to
  // shape — but it is still passed as an argument vector rather than a string,
  // because the day somebody widens the allowlist is the day that matters.
  const result = await runner.runtime.runCommand(
    runner.record.id,
    ['env', 'CI=1', 'NO_COLOR=1', 'npm', 'run', '--silent', script],
    { timeoutMs: CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES * 4 },
  );

  const combined = `${result.stdout}${result.stderr}`;
  const truncated = combined.length > MAX_OUTPUT_BYTES;
  return {
    script,
    ok: result.code === 0,
    exitCode: result.code,
    // Truncated from the *front* is wrong for a test run: the failure is
    // usually early and the summary is at the end, so both ends are kept.
    output: truncated
      ? `${combined.slice(0, MAX_OUTPUT_BYTES / 2)}\n… output truncated …\n${combined.slice(
          -MAX_OUTPUT_BYTES / 2,
        )}`
      : combined,
    truncated,
  };
}
