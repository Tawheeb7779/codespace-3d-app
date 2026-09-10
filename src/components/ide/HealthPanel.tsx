import { useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, HeartPulse, RefreshCw, TriangleAlert, XCircle } from 'lucide-react';
import { PanelHeader, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useFileStore } from '@/stores/fileStore';
import { useGitStore } from '@/stores/gitStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useConsoleStore } from '@/stores/consoleStore';
import { useCheckStore } from '@/stores/checkStore';
import { useUIStore, type BottomTab, type SidebarPanel } from '@/stores/uiStore';
import { scanProject } from '@/lib/security/scan';
import { buildHealthReport, type Metric, type MetricState } from '@/lib/health/report';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * How this project is doing, from what is actually known about it.
 *
 * Each row is good, bad, or **not measured** — and the third is shown as
 * plainly as the other two, with the reason it was not measured and what would
 * measure it. A dashboard that shows a green tick for a check nobody ran is
 * worse than no dashboard, because somebody ships on it.
 *
 * The score follows the same rule: it is computed only over the metrics that
 * were measured, and it is never displayed without saying how many that was.
 * "82, from 4 of 8 checks" is a fact a person can act on; "82" is a claim they
 * cannot evaluate.
 */

const STATE_ICON = {
  good: CheckCircle2,
  warn: TriangleAlert,
  bad: XCircle,
  unknown: CircleDashed,
};

const STATE_TONE: Record<MetricState, string> = {
  good: 'text-positive',
  warn: 'text-caution',
  bad: 'text-danger',
  unknown: 'text-ink-faint',
};

function MetricRow({ metric }: { metric: Metric }) {
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);
  const setBottomTab = useUIStore((s) => s.setBottomTab);
  const Icon = STATE_ICON[metric.state];

  return (
    <div className="flex items-start gap-2 border-b border-line px-2.5 py-2">
      <Icon aria-hidden className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', STATE_TONE[metric.state])} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          <span className="text-base text-ink">{metric.label}</span>
          {metric.state === 'unknown' && <Badge>not measured</Badge>}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">{metric.summary}</p>
        {/* Why it is unknown, so "not measured" is actionable rather than a
            shrug. */}
        {metric.unavailable && (
          <p className="mt-0.5 text-sm text-ink-faint">
            <span>{metric.unavailable}</span>
          </p>
        )}
        {metric.action && (metric.action.panel || metric.action.bottomTab) && (
          <Button
            size="xs"
            className="mt-1.5"
            onClick={() => {
              if (metric.action?.panel) setSidebarPanel(metric.action.panel as SidebarPanel);
              if (metric.action?.bottomTab) setBottomTab(metric.action.bottomTab as BottomTab);
            }}
          >
            {metric.action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

export function HealthPanel() {
  const repo = useGitStore((s) => s.repo);
  const status = useGitStore((s) => s.status);
  const history = useGitStore((s) => s.history);
  const preview = usePreviewStore();
  const entries = useConsoleStore((s) => s.entries);
  const results = useCheckStore((s) => s.results);

  const [scannedAt, setScannedAt] = useState(() => Date.now());

  /*
   * The security scan is the expensive part, so it is taken as a snapshot when
   * this panel is opened or refreshed rather than derived from the file store.
   * Everything else here is already-computed state and costs nothing to read.
   */
  const [securityReport, setSecurityReport] = useState(() =>
    scanProject(useFileStore.getState().files),
  );

  const report = useMemo(
    () =>
      buildHealthReport({
        build: {
          status: preview.status,
          errors: preview.errors,
          warnings: preview.warnings,
          lastBuildMs: preview.lastBuildMs,
        },
        checks: Object.values(results),
        security: securityReport,
        git: {
          initialized: repo.initialized,
          branch: repo.head,
          changedFiles: status.staged.length + status.unstaged.length,
          commits: history.length,
        },
        previewStatus: preview.status,
        runtimeErrors: entries.filter(
          (entry) => entry.channel === 'preview' && entry.level === 'error',
        ).length,
      }),
    [
      preview.status,
      preview.errors,
      preview.warnings,
      preview.lastBuildMs,
      results,
      securityReport,
      repo.initialized,
      repo.head,
      status.staged.length,
      status.unstaged.length,
      history.length,
      entries,
    ],
  );

  const worst = report.metrics.some((metric) => metric.state === 'bad')
    ? 'danger'
    : report.metrics.some((metric) => metric.state === 'warn')
      ? 'caution'
      : 'positive';
  const scoreColour = { danger: 'text-danger', caution: 'text-caution', positive: 'text-positive' }[
    worst
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Project health"
        actions={
          <IconButton
            label="Measure again"
            size="xs"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => {
              setSecurityReport(scanProject(useFileStore.getState().files));
              setScannedAt(Date.now());
            }}
          />
        }
      />

      <div className="shrink-0 border-b border-line px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          {report.score === null ? (
            <span className="text-2xl font-medium text-ink-faint">—</span>
          ) : (
            <span className={cx('text-2xl font-medium tabular-nums', scoreColour)}>
              {report.score}
            </span>
          )}
          {/* The denominator travels with the number, always. A score over four
              of eight checks is a different claim from a score over eight. */}
          <Badge tone={report.measured === report.total ? 'neutral' : 'caution'}>
            {report.measured} of {report.total} measured
          </Badge>
        </div>
        <p className="mt-1 text-sm text-ink-faint">
          {report.score === null ? (
            <span>
              Nothing has been measured yet. Run the preview, run a check, or open the security
              panel, and this becomes a reading rather than a blank.
            </span>
          ) : (
            <span>
              Averaged over the {report.measured} metric{report.measured === 1 ? '' : 's'} that were
              actually measured. The {report.total - report.measured} marked “not measured” are
              excluded — counting them as passes is how a dashboard says a project is healthy when
              nobody checked.
            </span>
          )}
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          <span>Security scanned {formatTimeAgo(scannedAt)}.</span>
        </p>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {report.metrics.map((metric) => (
          <MetricRow key={metric.id} metric={metric} />
        ))}
        <p className="flex items-start gap-1.5 px-2.5 py-2 text-sm text-ink-faint">
          <HeartPulse aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Every reading here comes from this session. Nothing is remembered across a reload,
            because a stored “tests passed” would be read as current when the code has changed
            since.
          </span>
        </p>
      </div>
    </div>
  );
}
