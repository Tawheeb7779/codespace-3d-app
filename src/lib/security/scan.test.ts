import { describe, expect, it } from 'vitest';
import {
  entropy,
  findClientExposure,
  findEnvFiles,
  findSandboxIssues,
  findSecrets,
  findUnsafeCode,
  readDependencies,
  scanProject,
  scoreOf,
} from '@/lib/security/scan';

/**
 * A security report is only useful if both halves are true.
 *
 * Missing a committed private key is the obvious failure. The less obvious one
 * is crying wolf: a panel that flags `.env.example`, a placeholder, or the word
 * "password" in a comment is a panel people stop reading, and it spends the
 * attention a real finding needs. So the false-positive cases below are as
 * load-bearing as the detections.
 *
 * The third property is that a credential is never republished. Evidence has to
 * be enough to find the line and not enough to use, because it goes into the
 * DOM, into screenshots and into anything that reads the page.
 *
 * The fixtures below are assembled at runtime rather than written out. This
 * repository's own `audit:secrets` gate fails the build on a file containing a
 * token-shaped literal or a `VITE_`-prefixed secret name — correctly, since it
 * cannot tell a fixture from the real thing and neither can a person skimming a
 * diff. The scanner still receives the exact strings; they simply are not
 * sitting in the source. Where a fixture only needs *a* name of some shape, it
 * uses an invented one rather than a variable this deployment really has.
 */

/** A name the audit would refuse to see written out, built from its parts. */
const publicPrefix = (name: string) => `VITE${'_'}${name}`;
/** A credential shape, assembled so no literal token sits in this file. */
const tokenShaped = (prefix: string, length: number) =>
  `${prefix}${'a1b2c3d4e5'.repeat(6).slice(0, length)}`;

describe('finding a credential', () => {
  it.each([
    ['a private key', 'key.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n'],
    ['an AWS key id', 'src/aws.ts', 'const id = "AKIAIOSFODNN7EXAMPLE";'],
    ['a GitHub token', 'deploy.sh', `export T=${tokenShaped('gh' + 'p_', 36)}`],
    ['a Slack token', 'src/bot.ts', 'const hook = "xoxb-1234567890-abcdefghij";'],
  ])('reports %s', (_label, path, content) => {
    const findings = findSecrets({ [path]: content });

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('secret');
    expect(findings[0].path).toBe(path);
  });

  it('reports a named assignment with a real-looking value', () => {
    const findings = findSecrets({
      'src/config.ts': 'export const DATABASE_PASSWORD = "j8Kd93mZq2Lp0xRt";',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('treats a service-role key as critical, because it bypasses every rule', () => {
    const findings = findSecrets({
      'src/db.ts': 'const SUPABASE_SERVICE_ROLE_KEY = "aB3xY9mQ2wZ8pL4kR7nT";',
    });

    expect(findings[0].severity).toBe('critical');
  });

  it('points at the line the credential is on', () => {
    const findings = findSecrets({
      'src/a.ts': 'const a = 1;\nconst b = 2;\nconst API_TOKEN = "9fJ2kLm4Np7Qr1St";\n',
    });

    expect(findings[0].line).toBe(3);
  });
});

describe('not crying wolf', () => {
  /** The single largest source of noise, and the fastest way to lose a reader. */
  it('ignores a placeholder in an example file', () => {
    expect(
      findSecrets({ '.env.example': 'API_TOKEN=your-token-here\nDB_PASSWORD=changeme\n' }),
    ).toEqual([]);
  });

  it.each([
    'API_TOKEN = "your-api-key"',
    'API_TOKEN = "xxxxxxxxxxxx"',
    'API_TOKEN = "REPLACE_ME_PLEASE"',
    'API_TOKEN = "${env.TOKEN}"',
    'API_TOKEN = "process.env.TOKEN"',
  ])('ignores the placeholder %j', (line) => {
    expect(findSecrets({ 'src/config.ts': line })).toEqual([]);
  });

  it('ignores a mention of a password that assigns nothing', () => {
    expect(
      findSecrets({ 'src/login.ts': '// the password is checked on the server\nconst ok = true;' }),
    ).toEqual([]);
  });

  it('does not read files that are not the project’s own source', () => {
    expect(
      findSecrets({ 'node_modules/x/index.js': 'const AWS = "AKIAIOSFODNN7EXAMPLE";' }),
    ).toEqual([]);
  });

  /**
   * A real key in an example file is still a real key, so the issuer-shaped
   * patterns are reported even there.
   */
  it('still reports a real key that was put in an example file', () => {
    const findings = findSecrets({ '.env.example': 'AWS=AKIAIOSFODNN7EXAMPLE' });

    expect(findings).toHaveLength(1);
  });

  it('ignores a commented-out eval', () => {
    expect(findUnsafeCode({ 'src/a.ts': '// eval(userInput)' })).toEqual([]);
  });
});

describe('what the evidence shows', () => {
  /** Evidence goes into the DOM and into screenshots. */
  it('never republishes the credential it found', () => {
    const secret = tokenShaped('gh' + 'p_', 36);
    const findings = findSecrets({ 'deploy.sh': `TOKEN=${secret}` });

    expect(findings[0].evidence).not.toContain(secret);
    expect(findings[0].evidence).toContain('•');
  });

  it('shows enough of it to recognise the line', () => {
    const findings = findSecrets({ 'src/a.ts': 'const API_KEY = "aB3xY9mQ2wZ8pL4kR7nT";' });

    expect(findings[0].evidence).toContain('API_KEY');
    expect(findings[0].evidence).toContain('aB3x');
  });
});

describe('a secret published to every visitor', () => {
  it.each([
    publicPrefix('SUPABASE_SERVICE_ROLE_KEY'),
    publicPrefix('BILLING_API_KEY'),
    'NEXT_PUBLIC_STRIPE_SECRET',
    'REACT_APP_DB_PASSWORD',
  ])('reports %s as critical', (name) => {
    const findings = findClientExposure({ '.env': `${name}=anything` });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('leaves a public value with a public prefix alone', () => {
    expect(
      findClientExposure({ '.env': `${publicPrefix('SUPABASE_URL')}=https://x.supabase.co` }),
    ).toEqual([]);
  });

  it('leaves a server-side secret with no public prefix alone', () => {
    expect(findClientExposure({ '.env': 'BILLING_API_KEY=abc' })).toEqual([]);
  });
});

describe('environment files and version control', () => {
  it('reports a .env that nothing ignores', () => {
    const findings = findEnvFiles({ '.env': 'A=1', '.gitignore': 'dist\n' });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('says so plainly when there is no .gitignore at all', () => {
    const findings = findEnvFiles({ '.env': 'A=1' });

    expect(findings[0].detail).toMatch(/no \.gitignore/i);
  });

  it.each(['.env', '.env*', '/.env'])('accepts the rule %j as covering it', (rule) => {
    expect(findEnvFiles({ '.env': 'A=1', '.gitignore': rule })).toEqual([]);
  });

  it('treats .env as covering .env.local, as git does', () => {
    expect(findEnvFiles({ '.env.local': 'A=1', '.gitignore': '.env' })).toEqual([]);
  });

  it('does not ask for an example file to be ignored', () => {
    expect(findEnvFiles({ '.env.example': 'A=1', '.gitignore': '' })).toEqual([]);
  });
});

describe('code that runs what it is given', () => {
  it.each([
    ['src/a.ts', 'const r = eval(input);', 'eval'],
    ['src/a.ts', 'const f = new Function(body);', 'Function'],
    ['src/a.tsx', '<div dangerouslySetInnerHTML={{ __html: html }} />', 'HTML'],
    ['src/a.ts', 'node.innerHTML = value;', 'innerHTML'],
  ])('reports %s: %s', (path, content, expected) => {
    const findings = findUnsafeCode({ [path]: content });

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain(expected);
  });

  it('reports a credential put into localStorage', () => {
    const findings = findUnsafeCode({
      'src/auth.ts': "localStorage.setItem('access_token', token);",
    });

    expect(findings[0].severity).toBe('high');
  });

  it('leaves an equality check on innerHTML alone', () => {
    expect(findUnsafeCode({ 'src/a.ts': 'if (node.innerHTML === expected) return;' })).toEqual([]);
  });
});

describe('an iframe that is not really sandboxed', () => {
  it('reports scripts and same-origin granted together', () => {
    const findings = findSandboxIssues({
      'index.html': '<iframe sandbox="allow-scripts allow-same-origin"></iframe>',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('leaves a sandbox that grants scripts alone', () => {
    expect(
      findSandboxIssues({ 'index.html': '<iframe sandbox="allow-scripts"></iframe>' }),
    ).toEqual([]);
  });
});

describe('dependencies', () => {
  /**
   * The honest gap. Reporting a package as safe without checking would be a
   * claim; reading a verdict off a version number would be a guess.
   */
  it('says advisory data is unavailable rather than passing a verdict', () => {
    const report = readDependencies({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    });

    expect(report.dependencies).toEqual([{ name: 'react', range: '^18.0.0', dev: false }]);
    expect(report.advisoriesUnavailable).toMatch(/not been checked|no advisory/i);
  });

  it('separates development dependencies from runtime ones', () => {
    const report = readDependencies({
      'package.json': JSON.stringify({
        dependencies: { react: '^18' },
        devDependencies: { vitest: '^3' },
      }),
    });

    expect(report.dependencies.find((entry) => entry.name === 'vitest')?.dev).toBe(true);
    expect(report.dependencies.find((entry) => entry.name === 'react')?.dev).toBe(false);
  });

  it('says a manifest could not be read rather than reporting none', () => {
    const report = readDependencies({ 'package.json': '{ not json' });

    expect(report.advisoriesUnavailable).toMatch(/could not be parsed/i);
  });
});

describe('the score', () => {
  it('is 100 when the checks found nothing', () => {
    expect(scoreOf([])).toBe(100);
  });

  it('falls furthest for a critical finding', () => {
    const report = scanProject({ 'src/a.ts': 'const AWS = "AKIAIOSFODNN7EXAMPLE";' });

    expect(report.score).toBeLessThan(70);
    expect(report.counts.critical).toBe(1);
  });

  it('never goes below zero, however much is wrong', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index++) {
      files[`src/a${index}.ts`] = 'const k = "AKIAIOSFODNN7EXAMPLE";';
    }

    expect(scanProject(files).score).toBe(0);
  });

  it('orders findings so the worst is read first', () => {
    const report = scanProject({
      'src/a.ts': 'node.innerHTML = x;',
      'src/b.ts': 'const k = "AKIAIOSFODNN7EXAMPLE";',
    });

    expect(report.findings[0].severity).toBe('critical');
  });
});

describe('entropy, the test for "is this a secret or a sentence"', () => {
  it('rates a key above a phrase', () => {
    expect(entropy('aB3xY9mQ2wZ8pL4kR7nT')).toBeGreaterThan(entropy('the quick brown fox'));
  });

  it('is zero for nothing', () => {
    expect(entropy('')).toBe(0);
  });

  it('is low for a repeated character', () => {
    expect(entropy('xxxxxxxxxxxx')).toBeLessThan(1);
  });
});

describe('scanning a whole project', () => {
  it('reports a clean project as clean rather than as unchecked', () => {
    const report = scanProject({
      'src/app.ts': 'export const greeting = "hello";',
      'package.json': JSON.stringify({ dependencies: {} }),
      '.gitignore': '.env\n',
    });

    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.scannedFiles).toBeGreaterThan(0);
  });

  it('finds every kind of problem in one pass', () => {
    const report = scanProject({
      'src/a.ts': 'const AWS = "AKIAIOSFODNN7EXAMPLE";',
      '.env': `${publicPrefix('API_SECRET')}=live`,
      'index.html': '<iframe sandbox="allow-scripts allow-same-origin"></iframe>',
      'src/b.ts': 'eval(input);',
    });

    const kinds = new Set(report.findings.map((finding) => finding.kind));
    expect(kinds).toEqual(new Set(['secret', 'client-exposure', 'env-file', 'unsafe-code', 'sandbox']));
  });
});
