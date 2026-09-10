import type { CheckOutcome } from '@/stores/checkStore';
import type { SecurityReport } from '@/lib/security/scan';

/**
 * How this project is doing, from what is actually known about it.
 *
 * The temptation in a health dashboard is a single green number, and the
 * failure mode is a project that shows 94% because the checks that would have
 * failed were never run. So every metric here is one of three things — good,
 * bad, or **unknown** — and unknown is a first-class answer that appears on
 * screen as "not measured", never as a pass and never quietly averaged away.
 *
 * The score is computed only from metrics that were actually measured, and it
 * is reported alongside how many that was. "82, from 4 of 8 checks" is a fact;
 * "82" alone is a claim nobody can evaluate.
 *
 * Pure functions over signals the app already holds. Nothing here runs a build,
 * a test or a scan; it reads what the parts that do those things recorded.
 */

export type MetricState = 'good' | 'warn' | 'bad' | 'unknown';

export interface Metric {
  id: string;
  label: string;
  state: MetricState;
  /** The reading, or why there isn't one. */
  summary: string;
  /**
   * Why this is unknown, when it is. Always the reason it was not measured —
   * never a hedge on a measurement that was taken.
   */
  unavailable?: string;
  /** Where a person goes to act on it. */
  action?: { label: string; panel?: string; bottomTab?: string };
}

export interface BuildSignal {
  status: 'idle' | 'building' | 'running' | 'error' | string;
  errors: unknown[];
  warnings: unknown[];
  lastBuildMs: number;
}

export function buildMetric(signal: BuildSignal): Metric {
  if (signal.status === 'idle') {
    return {
      id: 'build',
      label: 'Build',
      state: 'unknown',
      summary: 'Not built in this session.',
      unavailable: 'The preview has not been run, so nothing has been bundled yet.',
      action: { label: 'Run the preview' },
    };
  }
  if (signal.status === 'building') {
    return { id: 'build', label: 'Build', state: 'unknown', summary: 'Building…' };
  }
  if (signal.status === 'error' || signal.errors.length > 0) {
    return {
      id: 'build',
      label: 'Build',
      state: 'bad',
      summary: `${signal.errors.length} build error${signal.errors.length === 1 ? '' : 's'}.`,
      action: { label: 'Open Problems', bottomTab: 'problems' },
    };
  }
  return {
    id: 'build',
    label: 'Build',
    state: signal.warnings.length > 0 ? 'warn' : 'good',
    summary:
      signal.warnings.length > 0
        ? `Builds in ${signal.lastBuildMs}ms with ${signal.warnings.length} warning${signal.warnings.length === 1 ? '' : 's'}.`
        : `Builds in ${signal.lastBuildMs}ms.`,
  };
}

/**
 * Tests, and the distinction that matters most in this whole file.
 *
 * A project whose tests were never run is not a project whose tests pass. That
 * is the single most tempting lie a dashboard can tell, and the reason
 * `CheckOutcome` exists rather than a boolean.
 */
export function testMetric(results: CheckOutcome[]): Metric {
  const test = results.find((result) => result.script === 'test');
  if (!test) {
    return {
      id: 'tests',
      label: 'Tests',
      state: 'unknown',
      summary: 'Not run in this session.',
      unavailable:
        'Tests run in the project container. Attach the project terminal and run the test check to measure this.',
      action: { label: 'Open Checks', bottomTab: 'checks' },
    };
  }
  return {
    id: 'tests',
    label: 'Tests',
    state: test.ok ? 'good' : 'bad',
    summary: test.ok
      ? `Passed (exit ${test.exitCode}).`
      : `Failed (exit ${test.exitCode}).`,
    action: { label: 'Open Checks', bottomTab: 'checks' },
  };
}

/** Whatever other checks were run — lint, typecheck, build, verify. */
export function checksMetric(results: CheckOutcome[]): Metric {
  const others = results.filter((result) => result.script !== 'test');
  if (!others.length) {
    return {
      id: 'checks',
      label: 'Lint & types',
      state: 'unknown',
      summary: 'Not run in this session.',
      unavailable: 'No lint, typecheck, build or verify check has been run against the container.',
      action: { label: 'Open Checks', bottomTab: 'checks' },
    };
  }
  const failing = others.filter((result) => !result.ok);
  return {
    id: 'checks',
    label: 'Lint & types',
    state: failing.length ? 'bad' : 'good',
    summary: failing.length
      ? `${failing.map((result) => result.script).join(', ')} failing.`
      : `${others.map((result) => result.script).join(', ')} passing.`,
    action: { label: 'Open Checks', bottomTab: 'checks' },
  };
}

export function securityMetric(report: SecurityReport): Metric {
  const { critical, high } = report.counts;
  if (critical + high > 0) {
    return {
      id: 'security',
      label: 'Security',
      state: 'bad',
      summary: `${critical + high} serious finding${critical + high === 1 ? '' : 's'}.`,
      action: { label: 'Open Security', panel: 'security' },
    };
  }
  if (report.findings.length > 0) {
    return {
      id: 'security',
      label: 'Security',
      state: 'warn',
      summary: `${report.findings.length} minor finding${report.findings.length === 1 ? '' : 's'}.`,
      action: { label: 'Open Security', panel: 'security' },
    };
  }
  return {
    id: 'security',
    label: 'Security',
    state: 'good',
    // Named rather than implied: these checks found nothing, which is not the
    // same as the project being secure, and the wording has to carry that.
    summary: 'The secret, exposure, environment and sandbox checks found nothing.',
    action: { label: 'Open Security', panel: 'security' },
  };
}

/**
 * Dependencies, which this build genuinely cannot judge.
 *
 * There is no advisory database here. Reporting "no known vulnerabilities"
 * would be a claim about a thing nobody checked, so the count is a fact and the
 * verdict is explicitly unavailable.
 */
export function dependencyMetric(report: SecurityReport): Metric {
  const count = report.dependencies.dependencies.length;
  return {
    id: 'dependencies',
    label: 'Dependencies',
    state: 'unknown',
    summary: count
      ? `${count} declared. Not checked for vulnerabilities.`
      : 'None declared.',
    unavailable:
      report.dependencies.advisoriesUnavailable ??
      'No advisory database is configured, so nothing has been checked.',
  };
}

export interface GitSignal {
  initialized: boolean;
  branch: string;
  changedFiles: number;
  commits: number;
}

export function gitMetric(signal: GitSignal): Metric {
  if (!signal.initialized) {
    return {
      id: 'git',
      label: 'Version control',
      state: 'warn',
      summary: 'No repository yet.',
      action: { label: 'Open Source control', panel: 'git' },
    };
  }
  if (!signal.commits) {
    return {
      id: 'git',
      label: 'Version control',
      state: 'warn',
      summary: `On ${signal.branch}, with no commits yet.`,
      action: { label: 'Open Source control', panel: 'git' },
    };
  }
  return {
    id: 'git',
    label: 'Version control',
    state: signal.changedFiles > 0 ? 'warn' : 'good',
    summary:
      signal.changedFiles > 0
        ? `On ${signal.branch}, ${signal.changedFiles} file${signal.changedFiles === 1 ? '' : 's'} uncommitted.`
        : `On ${signal.branch}, everything committed.`,
    action: { label: 'Open Source control', panel: 'git' },
  };
}

/** The running application, as its own console reports it. */
export function runtimeMetric(signal: {
  previewStatus: string;
  runtimeErrors: number;
}): Metric {
  if (signal.previewStatus === 'idle') {
    return {
      id: 'runtime',
      label: 'Runtime',
      state: 'unknown',
      summary: 'The preview is not running.',
      unavailable: 'Nothing is running, so the application has reported nothing.',
    };
  }
  return {
    id: 'runtime',
    label: 'Runtime',
    state: signal.runtimeErrors > 0 ? 'bad' : 'good',
    summary: signal.runtimeErrors
      ? `${signal.runtimeErrors} runtime error${signal.runtimeErrors === 1 ? '' : 's'} in the preview.`
      : 'The preview is running with no errors reported.',
    action: { label: 'Open Observability', panel: 'observability' },
  };
}

/** Deployment, which needs infrastructure this build does not have. */
export function deploymentMetric(): Metric {
  return {
    id: 'deployment',
    label: 'Deployment',
    state: 'unknown',
    summary: 'No deployment target configured.',
    unavailable:
      'TA CODE has no deployment integration configured, so there is no deployment state to report.',
  };
}

export interface HealthReport {
  metrics: Metric[];
  /** 0–100 over the metrics that were measured. Null when none were. */
  score: number | null;
  /** How many metrics the score is based on, and how many exist. */
  measured: number;
  total: number;
}

const STATE_SCORE: Record<Exclude<MetricState, 'unknown'>, number> = {
  good: 100,
  warn: 60,
  bad: 0,
};

/**
 * The score, over what was measured and nothing else.
 *
 * An unknown metric is excluded rather than counted as either. Counting it as a
 * pass is the lie; counting it as a failure would punish a project for a check
 * nobody ran. Excluding it and reporting the denominator is the only honest
 * option, which is why `measured` travels with the number everywhere it goes.
 */
export function scoreOf(metrics: Metric[]): { score: number | null; measured: number } {
  const known = metrics.filter((metric) => metric.state !== 'unknown');
  if (!known.length) return { score: null, measured: 0 };
  const total = known.reduce(
    (sum, metric) => sum + STATE_SCORE[metric.state as Exclude<MetricState, 'unknown'>],
    0,
  );
  return { score: Math.round(total / known.length), measured: known.length };
}

export interface HealthInput {
  build: BuildSignal;
  checks: CheckOutcome[];
  security: SecurityReport;
  git: GitSignal;
  previewStatus: string;
  runtimeErrors: number;
}

export function buildHealthReport(input: HealthInput): HealthReport {
  const metrics = [
    buildMetric(input.build),
    testMetric(input.checks),
    checksMetric(input.checks),
    securityMetric(input.security),
    dependencyMetric(input.security),
    gitMetric(input.git),
    runtimeMetric({ previewStatus: input.previewStatus, runtimeErrors: input.runtimeErrors }),
    deploymentMetric(),
  ];
  const { score, measured } = scoreOf(metrics);
  return { metrics, score, measured, total: metrics.length };
}
