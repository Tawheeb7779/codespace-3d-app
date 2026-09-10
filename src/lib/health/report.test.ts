import { describe, expect, it } from 'vitest';
import {
  buildHealthReport,
  buildMetric,
  checksMetric,
  dependencyMetric,
  deploymentMetric,
  gitMetric,
  runtimeMetric,
  scoreOf,
  securityMetric,
  testMetric,
  type Metric,
} from '@/lib/health/report';
import { scanProject } from '@/lib/security/scan';
import type { CheckOutcome } from '@/stores/checkStore';

/**
 * A health dashboard's one real failure mode.
 *
 * It is not getting a number slightly wrong. It is showing a project as healthy
 * because the checks that would have failed were never run — a green tick for a
 * measurement nobody took, which somebody then ships on.
 *
 * So the property under test throughout is that "not measured" is a distinct,
 * visible answer, that it is never counted as a pass, and that the score always
 * travels with the count of what it was computed over.
 */

const check = (over: Partial<CheckOutcome> & { script: string }): CheckOutcome => ({
  ok: true,
  exitCode: 0,
  summary: '',
  at: 1,
  ...over,
});

const clean = () => scanProject({ 'src/a.ts': 'export const a = 1;', '.gitignore': '.env\n' });

describe('the build', () => {
  it('is unknown before anything has been built', () => {
    const metric = buildMetric({ status: 'idle', errors: [], warnings: [], lastBuildMs: 0 });

    expect(metric.state).toBe('unknown');
    expect(metric.unavailable).toBeTruthy();
  });

  it('is bad when the build failed', () => {
    const metric = buildMetric({ status: 'error', errors: [{}], warnings: [], lastBuildMs: 0 });

    expect(metric.state).toBe('bad');
  });

  it('is good when it built cleanly, and says how long it took', () => {
    const metric = buildMetric({ status: 'running', errors: [], warnings: [], lastBuildMs: 87 });

    expect(metric.state).toBe('good');
    expect(metric.summary).toContain('87ms');
  });

  it('warns rather than passes when it built with warnings', () => {
    const metric = buildMetric({ status: 'running', errors: [], warnings: [{}], lastBuildMs: 10 });

    expect(metric.state).toBe('warn');
  });
});

describe('the tests', () => {
  /** The single most tempting lie a dashboard can tell. */
  it('is unknown when they were never run, not good', () => {
    const metric = testMetric([]);

    expect(metric.state).toBe('unknown');
    expect(metric.state).not.toBe('good');
    expect(metric.summary).toMatch(/not run/i);
  });

  it('says how to measure it rather than leaving it a shrug', () => {
    expect(testMetric([]).unavailable).toMatch(/container|test check/i);
  });

  it('is good when they passed, with the exit code', () => {
    const metric = testMetric([check({ script: 'test', ok: true, exitCode: 0 })]);

    expect(metric.state).toBe('good');
    expect(metric.summary).toContain('exit 0');
  });

  it('is bad when they failed', () => {
    const metric = testMetric([check({ script: 'test', ok: false, exitCode: 1 })]);

    expect(metric.state).toBe('bad');
  });

  /** A lint run is not a test run. */
  it('stays unknown when some other check was run instead', () => {
    expect(testMetric([check({ script: 'lint' })]).state).toBe('unknown');
  });
});

describe('the other checks', () => {
  it('is unknown when none were run', () => {
    expect(checksMetric([]).state).toBe('unknown');
  });

  it('names which one is failing', () => {
    const metric = checksMetric([
      check({ script: 'lint', ok: false, exitCode: 1 }),
      check({ script: 'typecheck', ok: true }),
    ]);

    expect(metric.state).toBe('bad');
    expect(metric.summary).toContain('lint');
  });

  it('ignores the test check, which has its own row', () => {
    expect(checksMetric([check({ script: 'test' })]).state).toBe('unknown');
  });
});

describe('security', () => {
  it('is bad when there is a serious finding', () => {
    const report = scanProject({ 'src/a.ts': 'const k = "AKIAIOSFODNN7EXAMPLE";' });

    expect(securityMetric(report).state).toBe('bad');
  });

  /**
   * A clean scan is a clean *scan*. The wording has to carry that, because
   * "Security: good" alone reads as a guarantee nobody made.
   */
  it('names the checks that passed rather than declaring the project secure', () => {
    const metric = securityMetric(clean());

    expect(metric.state).toBe('good');
    expect(metric.summary).toMatch(/checks found nothing/i);
    expect(metric.summary).not.toMatch(/\bsecure\b/i);
  });
});

describe('dependencies', () => {
  /** There is no advisory database here, and saying otherwise would be a claim. */
  it('is always unknown, because nothing checked them', () => {
    const report = scanProject({ 'package.json': JSON.stringify({ dependencies: { react: '^18' } }) });
    const metric = dependencyMetric(report);

    expect(metric.state).toBe('unknown');
    expect(metric.summary).toContain('1 declared');
    expect(metric.summary).toMatch(/not checked/i);
  });
});

describe('version control', () => {
  it('warns when there is no repository', () => {
    expect(gitMetric({ initialized: false, branch: '', changedFiles: 0, commits: 0 }).state).toBe(
      'warn',
    );
  });

  it('warns on uncommitted work rather than calling it good', () => {
    const metric = gitMetric({ initialized: true, branch: 'main', changedFiles: 3, commits: 5 });

    expect(metric.state).toBe('warn');
    expect(metric.summary).toContain('3 files uncommitted');
  });

  it('is good with a clean tree', () => {
    expect(
      gitMetric({ initialized: true, branch: 'main', changedFiles: 0, commits: 5 }).state,
    ).toBe('good');
  });
});

describe('runtime and deployment', () => {
  it('is unknown while nothing is running', () => {
    expect(runtimeMetric({ previewStatus: 'idle', runtimeErrors: 0 }).state).toBe('unknown');
  });

  it('is bad when the running app reported errors', () => {
    expect(runtimeMetric({ previewStatus: 'running', runtimeErrors: 2 }).state).toBe('bad');
  });

  /** No deployment integration exists, so there is nothing to report. */
  it('reports deployment as unavailable rather than as fine', () => {
    const metric = deploymentMetric();

    expect(metric.state).toBe('unknown');
    expect(metric.unavailable).toMatch(/no deployment/i);
  });
});

describe('the score', () => {
  const metric = (state: Metric['state'], id: string = state): Metric => ({
    id,
    label: id,
    state,
    summary: '',
  });

  it('is nothing at all when nothing was measured', () => {
    const { score, measured } = scoreOf([metric('unknown', 'a'), metric('unknown', 'b')]);

    expect(score).toBeNull();
    expect(measured).toBe(0);
  });

  /** The whole point: an unrun check must not lift the number. */
  it('excludes unknown metrics rather than counting them as passes', () => {
    const withUnknown = scoreOf([metric('good', 'a'), metric('unknown', 'b')]);
    const withoutIt = scoreOf([metric('good', 'a')]);

    expect(withUnknown.score).toBe(withoutIt.score);
    expect(withUnknown.measured).toBe(1);
  });

  it('does not count an unknown metric as a failure either', () => {
    expect(scoreOf([metric('good', 'a'), metric('unknown', 'b')]).score).toBe(100);
  });

  it('falls when something is genuinely bad', () => {
    expect(scoreOf([metric('good', 'a'), metric('bad', 'b')]).score).toBe(50);
  });

  it('places a warning between a pass and a failure', () => {
    const warn = scoreOf([metric('warn', 'a')]).score!;

    expect(warn).toBeGreaterThan(0);
    expect(warn).toBeLessThan(100);
  });
});

describe('the whole report', () => {
  it('reports how many of its metrics it could measure', () => {
    const report = buildHealthReport({
      build: { status: 'idle', errors: [], warnings: [], lastBuildMs: 0 },
      checks: [],
      security: clean(),
      git: { initialized: true, branch: 'main', changedFiles: 0, commits: 2 },
      previewStatus: 'idle',
      runtimeErrors: 0,
    });

    expect(report.total).toBe(report.metrics.length);
    expect(report.measured).toBeLessThan(report.total);
    // Security and git were measurable; build, tests, checks, dependencies,
    // runtime and deployment were not.
    expect(report.measured).toBe(2);
  });

  it('never shows a perfect score for a project nothing was run against', () => {
    const report = buildHealthReport({
      build: { status: 'idle', errors: [], warnings: [], lastBuildMs: 0 },
      checks: [],
      security: clean(),
      git: { initialized: false, branch: '', changedFiles: 0, commits: 0 },
      previewStatus: 'idle',
      runtimeErrors: 0,
    });

    // Git is unmeasured-but-warned, so the score exists and is not 100.
    expect(report.measured).toBeLessThan(report.total);
    expect(report.score).not.toBe(100);
  });

  it('gives every metric a reason when it could not measure one', () => {
    const report = buildHealthReport({
      build: { status: 'idle', errors: [], warnings: [], lastBuildMs: 0 },
      checks: [],
      security: clean(),
      git: { initialized: true, branch: 'main', changedFiles: 0, commits: 1 },
      previewStatus: 'idle',
      runtimeErrors: 0,
    });

    for (const metric of report.metrics) {
      if (metric.state === 'unknown') expect(metric.unavailable).toBeTruthy();
    }
  });
});
