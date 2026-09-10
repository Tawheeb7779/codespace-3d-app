import { useMemo } from 'react';
import { AlertCircle, Gauge, Minus, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { usePerfStore } from '@/stores/perfStore';
import {
  breakdownOf,
  formatBytes,
  memoryReading,
  recommendationsFor,
  startupReading,
  trendBetween,
  unavailableMeasurements,
  type Measurement,
} from '@/lib/perf/metrics';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * What can be measured about this project, and — as prominently — what cannot.
 *
 * The measured half is real: bytes esbuild emitted, builds that were timed,
 * navigation timing for this tab. The unmeasured half is listed with the reason
 * rather than hidden, because a profiler that shows six panels and quietly
 * omits CPU reads as though CPU were fine.
 *
 * Three of those gaps come from decisions elsewhere in TA CODE that are worth
 * keeping: the preview is sandboxed without same-origin access, so its
 * rendering and network activity cannot be instrumented from here. The
 * isolation is the point, and the profiler says so rather than pretending the
 * numbers are unavailable by accident.
 */

function Reading({ measurement }: { measurement: Measurement }) {
  const unavailable = !measurement.availability.available;
  return (
    <div className="border-b border-line px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-base text-ink">{measurement.label}</span>
        {unavailable ? (
          <Badge>unavailable</Badge>
        ) : (
          <span className="font-mono text-base tabular-nums text-ink">
            {measurement.unit === 'bytes'
              ? formatBytes(measurement.value ?? 0)
              : `${measurement.value}${measurement.unit === 'ms' ? 'ms' : ''}`}
          </span>
        )}
      </div>
      {/* The reason it cannot be measured, so the gap is informative rather
          than a shrug. */}
      {unavailable && !measurement.availability.available && (
        <p className="mt-0.5 text-sm text-ink-faint">
          <span>{measurement.availability.reason}</span>
        </p>
      )}
      {!unavailable && measurement.note && (
        <p className="mt-0.5 text-sm text-ink-faint">
          <span>{measurement.note}</span>
        </p>
      )}
    </div>
  );
}

function TrendMark({ delta, percent }: { delta: number; percent: number | null }) {
  if (delta === 0) {
    return (
      <span className="flex items-center gap-0.5 text-sm text-ink-faint">
        <Minus aria-hidden className="h-3 w-3" />
        <span>no change</span>
      </span>
    );
  }
  const worse = delta > 0;
  const Icon = worse ? TrendingUp : TrendingDown;
  return (
    <span className={cx('flex items-center gap-0.5 text-sm', worse ? 'text-caution' : 'text-positive')}>
      <Icon aria-hidden className="h-3 w-3" />
      <span className="tabular-nums">
        {worse ? '+' : ''}
        {formatBytes(Math.abs(delta))}
        {percent === null ? '' : ` (${worse ? '+' : ''}${percent}%)`}
      </span>
    </span>
  );
}

export function PerformancePanel() {
  const samples = usePerfStore((s) => s.samples);
  const clear = usePerfStore((s) => s.clear);

  const latest = samples.find((sample) => sample.ok) ?? null;
  const breakdown = latest ? breakdownOf(latest) : null;

  const sizeTrend = useMemo(
    () => trendBetween(samples, (sample) => sample.js + sample.css + sample.html),
    [samples],
  );
  const timeTrend = useMemo(() => trendBetween(samples, (sample) => sample.durationMs), [samples]);
  const recommendations = useMemo(() => recommendationsFor(samples), [samples]);

  // Read at render: both are cheap, and a stale heap reading would be worse
  // than a current one.
  const memory = memoryReading();
  const startup = startupReading();
  const unavailable = unavailableMeasurements();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Performance"
        actions={
          samples.length > 0 ? (
            <IconButton
              label="Clear samples"
              size="xs"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={clear}
            />
          ) : null
        }
      />

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!latest ? (
          <EmptyState
            icon={<Gauge className="h-4 w-4" />}
            title="No build measured yet"
            description="Run the preview. Each build records its real time and output size here, and the second one can be compared with the first."
          />
        ) : (
          <>
            <section>
              <p className="panel-label px-2.5 py-1">Last build</p>
              <div className="border-b border-line px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-base text-ink">Build time</span>
                  <span className="font-mono text-base tabular-nums text-ink">
                    {latest.durationMs}ms
                  </span>
                </div>
                {timeTrend && (
                  <p className="mt-0.5">
                    <span className="text-sm text-ink-faint">
                      {timeTrend.delta === 0
                        ? 'Same as the previous build.'
                        : `${timeTrend.delta > 0 ? '+' : ''}${timeTrend.delta}ms against the previous build.`}
                    </span>
                  </p>
                )}
              </div>

              <div className="border-b border-line px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-base text-ink">Bundle</span>
                  <span className="font-mono text-base tabular-nums text-ink">
                    {formatBytes(breakdown!.total)}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  <dt className="text-ink-faint">JavaScript</dt>
                  <dd className="font-mono tabular-nums text-ink-muted">
                    {formatBytes(breakdown!.js)}
                  </dd>
                  <dt className="text-ink-faint">CSS</dt>
                  <dd className="font-mono tabular-nums text-ink-muted">
                    {formatBytes(breakdown!.css)}
                  </dd>
                  <dt className="text-ink-faint">Document</dt>
                  <dd className="font-mono tabular-nums text-ink-muted">
                    {formatBytes(breakdown!.html)}
                  </dd>
                  <dt className="text-ink-faint">From a CDN</dt>
                  <dd className="tabular-nums text-ink-muted">
                    {breakdown!.externals} package{breakdown!.externals === 1 ? '' : 's'}
                  </dd>
                </dl>
                {sizeTrend && (
                  <p className="mt-1">
                    <TrendMark delta={sizeTrend.delta} percent={sizeTrend.percent} />
                  </p>
                )}
                {/* Uncompressed, because that is what was measured. Reporting a
                    gzip estimate as though it were observed is the kind of
                    number this panel exists not to produce. */}
                <p className="mt-1 text-sm text-ink-faint">
                  <span>Uncompressed bytes, as the bundler emitted them. Servers usually compress.</span>
                </p>
              </div>
            </section>

            {recommendations.length > 0 && (
              <section>
                <p className="panel-label px-2.5 py-1">Recommendations</p>
                {recommendations.map((recommendation) => (
                  <div
                    key={recommendation.id}
                    className="flex items-start gap-2 border-b border-line px-2.5 py-2"
                  >
                    <AlertCircle
                      aria-hidden
                      className={cx(
                        'mt-0.5 h-3 w-3 shrink-0',
                        recommendation.severity === 'high'
                          ? 'text-danger'
                          : recommendation.severity === 'medium'
                            ? 'text-caution'
                            : 'text-ink-faint',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-base text-ink">{recommendation.title}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">{recommendation.detail}</p>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <section>
              <p className="panel-label px-2.5 py-1">
                Build history ({samples.length} this session)
              </p>
              {samples.slice(0, 10).map((sample) => (
                <p
                  key={sample.at}
                  className="flex items-baseline gap-2 border-b border-line px-2.5 py-1 text-sm"
                >
                  <span className="min-w-0 flex-1 text-ink-faint">{formatTimeAgo(sample.at)}</span>
                  {sample.ok ? (
                    <>
                      <span className="font-mono tabular-nums text-ink-muted">
                        {sample.durationMs}ms
                      </span>
                      <span className="font-mono tabular-nums text-ink-muted">
                        {formatBytes(sample.js + sample.css + sample.html)}
                      </span>
                    </>
                  ) : (
                    <Badge tone="danger">failed</Badge>
                  )}
                </p>
              ))}
            </section>
          </>
        )}

        <section>
          <p className="panel-label px-2.5 py-1">This session</p>
          <Reading measurement={startup} />
          <Reading measurement={memory} />
        </section>

        <section>
          <p className="panel-label px-2.5 py-1">Not measurable here</p>
          {unavailable.map((measurement) => (
            <Reading key={measurement.id} measurement={measurement} />
          ))}
          <p className="px-2.5 py-2 text-sm text-ink-faint">
            <span>
              These need capabilities a page does not have, or would require reaching into the
              sandboxed preview — which is isolated on purpose. Your browser’s own performance tools
              can profile the preview frame directly.
            </span>
          </p>
        </section>
      </div>
    </div>
  );
}
