/**
 * What is wrong with this project, from the project itself.
 *
 * Every finding below is read out of the user's own files. Nothing is fetched,
 * nothing is inferred from a package name, and nothing is scored by vibes: a
 * finding names a file, a line and the text that produced it, so it can be
 * checked rather than believed. A security panel that reports things it has not
 * established is worse than no panel, because it spends the attention that a
 * real finding needs.
 *
 * The counterpart of that is the gap. Dependency vulnerabilities need an
 * advisory database, and this has none — so the dependency section reports what
 * is installed and says plainly that advisory data is not available, rather
 * than inventing a verdict from version numbers.
 *
 * These are pure functions over the virtual file system. They do no I/O, so the
 * scan runs where the files already are and the tests drive the real thing.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingKind =
  | 'secret'
  | 'client-exposure'
  | 'env-file'
  | 'unsafe-code'
  | 'sandbox';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** What is wrong, in one sentence. */
  title: string;
  /** Why it matters, and what to do. */
  detail: string;
  path: string;
  line: number;
  /** The matching text, redacted where it is a credential. */
  evidence: string;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
};

/** Files that are not the project's own source and would only add noise. */
const IGNORED = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;

/**
 * Extensions worth reading as text.
 *
 * Key and certificate extensions are here deliberately: `.pem` is precisely
 * where a private key lives, and a scanner that skips it misses the finding it
 * most needs to make.
 */
const SCANNABLE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|env|sh|yml|yaml|toml|html|md|txt|pem|key|crt|cer|p12|pfx|conf|cfg|ini|properties)$|(^|\/)\.env/;

/**
 * A credential, shown as evidence without being republished.
 *
 * The panel has to show enough for somebody to find the line, and showing the
 * key itself would copy a live secret into the DOM, into a screenshot and into
 * anything that reads the page.
 */
function redact(value: string): string {
  const clean = value.trim();
  if (clean.length <= 8) return '•'.repeat(clean.length);
  return `${clean.slice(0, 4)}${'•'.repeat(Math.min(16, clean.length - 8))}${clean.slice(-4)}`;
}

/**
 * Shannon entropy per character.
 *
 * The test for "is this string a secret or a sentence". A base64 key sits well
 * above 4 bits; an English phrase and a kebab-case identifier sit below 3.5.
 */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    total -= p * Math.log2(p);
  }
  return total;
}

/** Credentials with a shape distinctive enough to name the issuer. */
const KNOWN_SECRETS: Array<{ pattern: RegExp; title: string; severity: Severity }> = [
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    title: 'A private key is committed in this project',
    severity: 'critical',
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, title: 'An AWS access key id is in this file', severity: 'critical' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, title: 'A GitHub token is in this file', severity: 'critical' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, title: 'An API key is in this file', severity: 'critical' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, title: 'A Slack token is in this file', severity: 'critical' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    title: 'A signed token (JWT) is in this file',
    severity: 'high',
  },
];

/**
 * An assignment whose *name* says it is a credential.
 *
 * The characters around the keyword are optional. Requiring at least one before
 * it — the obvious spelling — matched `DATABASE_PASSWORD` and missed a bare
 * `API_KEY`, which is the more common way to write it.
 */
const SECRET_NAME =
  /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|SERVICE_ROLE)[A-Za-z0-9_]*)\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/i;

/**
 * Values that name a credential without being one.
 *
 * A placeholder in an example file is the single largest source of false
 * positives, and a panel that cries wolf about `.env.example` is a panel people
 * stop reading.
 */
const PLACEHOLDER =
  /^(?:your|my|the|xxx|placeholder|example|changeme|replace|todo|dummy|test|sample|fake|<|\$\{|process\.env|import\.meta)/i;

function isPlaceholder(value: string): boolean {
  const clean = value.trim();
  if (PLACEHOLDER.test(clean)) return true;
  if (/^[x*•.\-_]+$/i.test(clean)) return true;
  // A value with no variety is a stand-in, whatever it is called.
  return entropy(clean) < 2.5;
}

/** True when this path is an example rather than a real configuration. */
function isExample(path: string): boolean {
  return /\.(example|sample|template|dist)$|\.env\.(example|sample|template)$|(^|\/)(README|CONTRIBUTING)/i.test(
    path,
  );
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Credentials sitting in the project's files.
 *
 * Two passes: shapes that identify their issuer, which are reported even in an
 * example file because a real AWS key in `.env.example` is still a real AWS
 * key; and name-plus-value assignments, which are only reported when the value
 * does not look like a placeholder.
 */
export function findSecrets(files: Record<string, string>): Finding[] {
  const findings: Finding[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (IGNORED.test(path) || !SCANNABLE.test(path)) continue;
    if (content.length > 512 * 1024) continue;

    for (const { pattern, title, severity } of KNOWN_SECRETS) {
      const match = pattern.exec(content);
      if (!match) continue;
      findings.push({
        id: `secret:${path}:${match.index}`,
        kind: 'secret',
        severity,
        title,
        detail:
          'Move it to an environment variable that is read on the server, and revoke this one — a credential that has been in a file must be treated as known.',
        path,
        line: lineOf(content, match.index),
        evidence: redact(match[0]),
      });
    }

    // An example file's *named* values are placeholders by definition.
    if (isExample(path)) continue;

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const match = SECRET_NAME.exec(lines[index]);
      if (!match) continue;
      const [, name, value] = match;
      if (isPlaceholder(value)) continue;
      findings.push({
        id: `secret-name:${path}:${index}`,
        kind: 'secret',
        severity: /SERVICE_ROLE|PRIVATE_KEY/i.test(name) ? 'critical' : 'high',
        title: `${name} is assigned a literal value`,
        detail:
          'A credential in source is a credential in version control, in every clone and in every build. Read it from the environment instead.',
        path,
        line: index + 1,
        evidence: `${name} = ${redact(value)}`,
      });
    }
  }
  return findings;
}

/**
 * Secrets that would be published to every visitor.
 *
 * Vite inlines anything prefixed `VITE_` into the bundle, so a server secret
 * that acquires that prefix is published with no error and no visible change.
 * This is the same rule the repository's own build gate enforces on itself, and
 * it is worth the user's project having it too.
 */
export function findClientExposure(files: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  const dangerous =
    /\b(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|SERVICE_ROLE)[A-Za-z0-9_]*\b/i;

  for (const [path, content] of Object.entries(files)) {
    if (IGNORED.test(path) || !SCANNABLE.test(path)) continue;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const match = dangerous.exec(lines[index]);
      if (!match) continue;
      findings.push({
        id: `exposure:${path}:${index}`,
        kind: 'client-exposure',
        severity: 'critical',
        title: `${match[0]} is published to the browser`,
        detail:
          'This prefix means the value is inlined into JavaScript that every visitor downloads. Anything secret must be read on a server and never carry a public prefix.',
        path,
        line: index + 1,
        evidence: match[0],
      });
    }
  }
  return findings;
}

/**
 * An environment file that version control would take with it.
 *
 * Reported as a *risk* rather than a leak: this cannot see the repository's
 * history, so it says what would happen rather than claiming what did.
 */
export function findEnvFiles(files: Record<string, string>): Finding[] {
  const ignoreFile = files['.gitignore'] ?? '';
  const ignored = ignoreFile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const covers = (path: string) =>
    ignored.some((rule) => {
      const bare = rule.replace(/^\/+|\/+$/g, '');
      if (!bare) return false;
      if (bare === path) return true;
      if (bare === '.env' && path.startsWith('.env')) return true;
      if (bare.endsWith('*') && path.startsWith(bare.slice(0, -1))) return true;
      return false;
    });

  const findings: Finding[] = [];
  for (const path of Object.keys(files)) {
    if (!/(^|\/)\.env(\.|$)/.test(path)) continue;
    if (isExample(path)) continue;
    if (covers(path)) continue;
    findings.push({
      id: `env:${path}`,
      kind: 'env-file',
      severity: 'high',
      title: `${path} is not ignored by git`,
      detail: ignoreFile
        ? `Add ${path} to .gitignore. An environment file that is committed puts every value in it into the repository's history.`
        : 'This project has no .gitignore, so an environment file would be committed with everything in it.',
      path,
      line: 1,
      evidence: path,
    });
  }
  return findings;
}

/** Code that hands untrusted input to something that executes or renders it. */
export function findUnsafeCode(files: Record<string, string>): Finding[] {
  const checks: Array<{ pattern: RegExp; title: string; detail: string; severity: Severity }> = [
    {
      pattern: /\beval\s*\(/,
      title: 'eval() executes whatever it is given',
      detail:
        'Any value that reaches it is code. If any part of that value can come from a user, a URL or a response, this is remote code execution.',
      severity: 'high',
    },
    {
      pattern: /new\s+Function\s*\(/,
      title: 'new Function() compiles a string into code',
      detail: 'The same risk as eval, and it evades a search for eval.',
      severity: 'high',
    },
    {
      pattern: /dangerouslySetInnerHTML/,
      title: 'HTML is being injected without escaping',
      detail:
        'React escapes by default and this opts out. If the value is not from a sanitiser, it is a cross-site scripting hole.',
      severity: 'medium',
    },
    {
      pattern: /\.innerHTML\s*=(?!=)/,
      title: 'innerHTML is assigned directly',
      detail: 'Markup in the value is parsed and run. Use textContent, or sanitise first.',
      severity: 'medium',
    },
    {
      pattern: /localStorage\.setItem\(\s*['"`][^'"`]*(?:token|secret|password|key)[^'"`]*['"`]/i,
      title: 'A credential is stored in localStorage',
      detail:
        'Anything running on the page can read it, including a compromised dependency, and it survives the session.',
      severity: 'high',
    },
  ];

  const findings: Finding[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (IGNORED.test(path) || !/\.(ts|tsx|js|jsx|mjs|cjs|html)$/.test(path)) continue;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      // A commented-out line is not running code.
      if (/^\s*(?:\/\/|\*|#)/.test(line)) continue;
      for (const check of checks) {
        if (!check.pattern.test(line)) continue;
        findings.push({
          id: `unsafe:${check.title}:${path}:${index}`,
          kind: 'unsafe-code',
          severity: check.severity,
          title: check.title,
          detail: check.detail,
          path,
          line: index + 1,
          evidence: line.trim().slice(0, 160),
        });
      }
    }
  }
  return findings;
}

/**
 * An iframe sandbox that grants itself away.
 *
 * `allow-scripts` with `allow-same-origin` lets the framed document reach into
 * the parent origin — which is to say it is not sandboxed. This is the rule TA
 * CODE's own preview obeys, and the reason it obeys it.
 */
export function findSandboxIssues(files: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (IGNORED.test(path) || !/\.(html|tsx|jsx|ts|js)$/.test(path)) continue;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!/sandbox/.test(line)) continue;
      if (!(line.includes('allow-scripts') && line.includes('allow-same-origin'))) continue;
      findings.push({
        id: `sandbox:${path}:${index}`,
        kind: 'sandbox',
        severity: 'high',
        title: 'This sandbox grants scripts and same-origin together',
        detail:
          'Together they let the framed page reach the parent origin and remove its own sandbox. Drop allow-same-origin, or do not run scripts.',
        path,
        line: index + 1,
        evidence: line.trim().slice(0, 160),
      });
    }
  }
  return findings;
}

export interface DependencyReport {
  /** Name and range, exactly as the manifest declares them. */
  dependencies: Array<{ name: string; range: string; dev: boolean }>;
  /**
   * Why there is no vulnerability verdict.
   *
   * Present whenever advisories could not be consulted, which is always in this
   * build: reporting a package as safe without checking would be a claim, and
   * reporting one as vulnerable from its version number alone would be a guess.
   */
  advisoriesUnavailable: string | null;
}

export function readDependencies(files: Record<string, string>): DependencyReport {
  const manifest = files['package.json'];
  if (!manifest) {
    return {
      dependencies: [],
      advisoriesUnavailable: 'This project has no package.json.',
    };
  }
  try {
    const parsed = JSON.parse(manifest) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = [
      ...Object.entries(parsed.dependencies ?? {}).map(([name, range]) => ({
        name,
        range: String(range),
        dev: false,
      })),
      ...Object.entries(parsed.devDependencies ?? {}).map(([name, range]) => ({
        name,
        range: String(range),
        dev: true,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    return {
      dependencies,
      advisoriesUnavailable:
        'No advisory database is configured, so nothing here has been checked for known vulnerabilities. Run `npm audit` where the project is installed.',
    };
  } catch {
    return {
      dependencies: [],
      advisoriesUnavailable: 'package.json could not be parsed, so its dependencies were not read.',
    };
  }
}

export interface SecurityReport {
  findings: Finding[];
  dependencies: DependencyReport;
  /** 0–100. What it means is stated below, because a bare number is not a fact. */
  score: number;
  counts: Record<Severity, number>;
  scannedFiles: number;
}

/**
 * One number, and what it does not mean.
 *
 * The score is 100 less a weight per finding, floored at zero. It is a summary
 * of *what was checked*, not a statement that a project is secure: the checks
 * here are secrets, client exposure, environment files, a handful of unsafe
 * calls and sandbox flags. A hundred means those found nothing.
 */
export function scoreOf(findings: Finding[]): number {
  const penalty = findings.reduce((total, finding) => total + SEVERITY_WEIGHT[finding.severity], 0);
  return Math.max(0, 100 - penalty);
}

export function scanProject(files: Record<string, string>): SecurityReport {
  const findings = [
    ...findSecrets(files),
    ...findClientExposure(files),
    ...findEnvFiles(files),
    ...findUnsafeCode(files),
    ...findSandboxIssues(files),
  ];

  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  findings.sort(
    (a, b) =>
      order.indexOf(a.severity) - order.indexOf(b.severity) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    findings,
    dependencies: readDependencies(files),
    score: scoreOf(findings),
    counts,
    scannedFiles: Object.keys(files).filter(
      (path) => !IGNORED.test(path) && SCANNABLE.test(path),
    ).length,
  };
}
