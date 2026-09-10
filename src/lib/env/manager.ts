/**
 * Environments, and the variables each one needs.
 *
 * **This deliberately does not store secret values.** A browser has nowhere to
 * put a production credential that a browser cannot also read, and TA CODE's
 * own scanner flags exactly that pattern in a user's code. So what is managed
 * here is the part that can be managed honestly: which variables each
 * environment requires, which are secret, where the code refers to them, and
 * whether the files that would hold them are safe from version control. The
 * values themselves live where they belong — in `.env` files that git ignores,
 * and in whatever runs the deployment.
 *
 * That is a smaller feature than a vault that claims to hold secrets, and it is
 * the one that is true. The panel says so rather than presenting an empty
 * value field as though something failed to load.
 *
 * **Usage is read from the code, not declared.** `process.env.X` and
 * `import.meta.env.X` are found by scanning the project, so "which environment
 * variables does this project actually use" is answered by the project rather
 * than by a list somebody kept up to date once.
 */

export type EnvironmentId = 'development' | 'preview' | 'production';

export const ENVIRONMENTS: readonly EnvironmentId[] = ['development', 'preview', 'production'];

export const ENVIRONMENT_LABEL: Record<EnvironmentId, string> = {
  development: 'Development',
  preview: 'Preview',
  production: 'Production',
};

export const ENVIRONMENT_NOTE: Record<EnvironmentId, string> = {
  development: 'Your machine, and this browser. Values come from .env files git ignores.',
  preview: 'Branch and pull-request builds. Values come from the deployment platform.',
  production: 'What users reach. Changing anything here affects them.',
};

export interface EnvVariable {
  key: string;
  /**
   * Which environments declare this variable. A variable can be needed in one
   * and not another, and pretending otherwise hides a missing production value.
   */
  environments: EnvironmentId[];
  /** True when the value is a credential and must never be stored here. */
  secret: boolean;
  /** A non-secret value, which is ordinary configuration and safe to keep. */
  value: string;
  /** What it is for, so a name alone does not have to carry the meaning. */
  note: string;
}

/** Where the code refers to a variable. */
export interface VariableUsage {
  key: string;
  path: string;
  line: number;
  /** True when the reference is one a bundler inlines into client code. */
  clientSide: boolean;
}

const IGNORED = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Prefixes a bundler publishes to the browser.
 *
 * A variable read through one of these is not configuration that happens to be
 * client-side — it *is* client-side, and marking it secret is a contradiction
 * the panel should point out rather than accept.
 */
const PUBLIC_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_)/;

export function isPublicPrefixed(key: string): boolean {
  return PUBLIC_PREFIX.test(key);
}

/**
 * Every environment variable the project's code actually reads.
 *
 * Both spellings, because a project can use either and a list that covers one
 * would quietly under-report the other.
 */
export function findUsages(files: Record<string, string>): VariableUsage[] {
  const usages: VariableUsage[] = [];
  const pattern =
    /(?:process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"`]([^'"`]+)['"`]\]|import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*))/g;

  for (const [path, content] of Object.entries(files)) {
    if (IGNORED.test(path) || !SOURCE.test(path)) continue;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      for (const match of lines[index].matchAll(pattern)) {
        const key = match[1] ?? match[2] ?? match[3];
        if (!key) continue;
        usages.push({
          key,
          path,
          line: index + 1,
          // `import.meta.env` is Vite's, and is inlined at build time.
          clientSide: Boolean(match[3]) || isPublicPrefixed(key),
        });
      }
    }
  }
  return usages;
}

/** Variable names declared in a `.env`-style file, values deliberately ignored. */
export function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(clean);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Which `.env` files the project has, and what each declares. */
export function envFilesIn(files: Record<string, string>): Array<{
  path: string;
  keys: string[];
  example: boolean;
}> {
  return Object.entries(files)
    .filter(([path]) => /(^|\/)\.env(\.|$)/.test(path))
    .map(([path, content]) => ({
      path,
      keys: parseEnvKeys(content),
      example: /\.(example|sample|template)$/.test(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export type IssueKind =
  | 'undeclared'
  | 'unused'
  | 'secret-published'
  | 'missing-in-environment';

export interface EnvIssue {
  kind: IssueKind;
  key: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
}

/**
 * What is wrong between what the code reads and what the environments declare.
 *
 * The four questions worth asking, and no more: does the code read something
 * nobody declared, is something declared that nothing reads, is a variable
 * marked secret while being published to the browser, and is a variable missing
 * from an environment that will need it.
 */
export function findIssues(
  variables: EnvVariable[],
  usages: VariableUsage[],
  environment: EnvironmentId,
): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const declared = new Set(variables.map((variable) => variable.key));
  const used = new Set(usages.map((usage) => usage.key));

  for (const key of used) {
    if (declared.has(key)) continue;
    issues.push({
      kind: 'undeclared',
      key,
      severity: 'high',
      message: `The code reads ${key}, but no environment declares it. It will be undefined at run time.`,
    });
  }

  for (const variable of variables) {
    if (!used.has(variable.key)) {
      issues.push({
        kind: 'unused',
        key: variable.key,
        severity: 'low',
        message: `${variable.key} is declared but nothing in the project reads it.`,
      });
    }

    /*
     * The contradiction worth catching.
     *
     * A `VITE_`-prefixed variable is inlined into JavaScript every visitor
     * downloads. Marking it secret does not make it private; it makes the label
     * wrong, which is worse than no label because somebody trusts it.
     */
    if (variable.secret && isPublicPrefixed(variable.key)) {
      issues.push({
        kind: 'secret-published',
        key: variable.key,
        severity: 'high',
        message: `${variable.key} is marked secret but its prefix publishes it to every visitor. Read it on a server, or accept that it is public.`,
      });
    }

    if (!variable.environments.includes(environment) && used.has(variable.key)) {
      issues.push({
        kind: 'missing-in-environment',
        key: variable.key,
        severity: environment === 'production' ? 'high' : 'medium',
        message: `${variable.key} is read by the code but is not declared for ${ENVIRONMENT_LABEL[environment]}.`,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
}

/**
 * Whether a change to this environment should be confirmed first.
 *
 * Production only. A confirmation on every environment is a confirmation people
 * click through without reading, which is worse than none — it trains the
 * reflex that makes the production one useless.
 */
export function needsConfirmation(environment: EnvironmentId): boolean {
  return environment === 'production';
}

export interface VaultStatus {
  /** Variables whose value this cannot hold, and the reason. */
  secretCount: number;
  /** Where those values actually live for this environment. */
  wherePlaced: string;
}

export function vaultStatus(
  variables: EnvVariable[],
  environment: EnvironmentId,
): VaultStatus {
  const secrets = variables.filter(
    (variable) => variable.secret && variable.environments.includes(environment),
  );
  return {
    secretCount: secrets.length,
    wherePlaced:
      environment === 'development'
        ? 'a .env file that git ignores, on your machine'
        : environment === 'preview'
          ? 'the deployment platform’s environment settings for preview builds'
          : 'the deployment platform’s environment settings for production',
  };
}
