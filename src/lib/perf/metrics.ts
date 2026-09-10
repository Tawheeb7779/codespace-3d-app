/**
 * What can actually be measured about this project, and what cannot.
 *
 * A profiler's whole value is that its numbers are real. So every reading here
 * comes from something that was genuinely observed — bytes esbuild emitted, a
 * build that was timed, `performance.now()` — and everything that would need a
 * capability this runtime does not have is reported as **unavailable with the
 * reason**, never as a zero and never as an estimate wearing a measurement's
 * clothes.
 *
 * The honest gaps are large and worth naming plainly:
 *
 * - **CPU profiling** needs the browser's own profiler, which a page cannot
 *   start on itself. There is no API for it, so there is no CPU flame graph.
 * - **Memory** is `performance.memory`, a non-standard Chromium extension. It
 *   is absent in Firefox and Safari, and it reports the whole tab — TA CODE,
 *   Monaco, esbuild and the preview together — not the user's application.
 * - **Rendering** metrics for the preview would have to come from inside the
 *   sandboxed frame, which has no same-origin access and therefore cannot be
 *   instrumented from here.
 * - **Network timing** for the user's app is likewise inside that frame.
 *
 * What is left is genuinely useful and genuinely measured: build time, real
 * output bytes, dependency weight, and how the IDE itself started.
 */

export interface BuildSample {
  at: number;
  durationMs: number;
  js: number;
  css: number;
  html: number;
  /** Bare specifiers the preview fetches from a CDN at run time. */
  externals: number;
  ok: boolean;
}

export type Availability =
  | { available: true }
  | { available: false; reason: string };

export interface Measurement {
  id: string;
  label: string;
  /** Null when unavailable. Never a placeholder number. */
  value: number | null;
  unit: 'ms' | 'bytes' | 'count' | 'percent';
  availability: Availability;
  /** What the number is, when it is easy to read it as something else. */
  note?: string;
}

/** Bytes, at the scale a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Memory, if this browser offers it.
 *
 * Chromium only, non-standard, and about the whole tab rather than the user's
 * application — all three of which the caller has to say, or the number is
 * read as the project's memory use, which it is not.
 */
export function memoryReading(): Measurement {
  const memory = (
    performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }
  ).memory;

  if (!memory || typeof memory.usedJSHeapSize !== 'number') {
    return {
      id: 'memory',
      label: 'JavaScript heap',
      value: null,
      unit: 'bytes',
      availability: {
        available: false,
        reason:
          'performance.memory is a non-standard Chromium API and this browser does not provide it. No other API exposes heap size to a page.',
      },
    };
  }

  return {
    id: 'memory',
    label: 'JavaScript heap',
    value: memory.usedJSHeapSize,
    unit: 'bytes',
    availability: { available: true },
    note:
      'The whole tab — TA CODE, Monaco, esbuild and the preview together — not your application alone. The preview runs in a separate frame this cannot measure.',
  };
}

/**
 * How long this tab took to become usable.
 *
 * Navigation timing is standard and real. It measures TA CODE starting, which
 * is worth knowing and is *not* the user's application starting — said in the
 * note, because the two are easy to confuse in a panel about a project.
 */
export function startupReading(): Measurement {
  const entries = performance.getEntriesByType?.('navigation') as PerformanceNavigationTiming[] | undefined;
  const navigation = entries?.[0];

  if (!navigation || !navigation.domContentLoadedEventEnd) {
    return {
      id: 'startup',
      label: 'IDE startup',
      value: null,
      unit: 'ms',
      availability: {
        available: false,
        reason: 'This browser reported no navigation timing for the current document.',
      },
    };
  }

  return {
    id: 'startup',
    label: 'IDE startup',
    value: Math.round(navigation.domContentLoadedEventEnd),
    unit: 'ms',
    availability: { available: true },
    note: 'How long TA CODE took to become interactive, not how long your application takes.',
  };
}

/** The measurements that need a capability nothing here has. */
export function unavailableMeasurements(): Measurement[] {
  return [
    {
      id: 'cpu',
      label: 'CPU profile',
      value: null,
      unit: 'ms',
      availability: {
        available: false,
        reason:
          'A page cannot start the browser’s profiler on itself; there is no API for it. Use the browser’s own performance tools for a CPU profile.',
      },
    },
    {
      id: 'render',
      label: 'Preview rendering',
      value: null,
      unit: 'ms',
      availability: {
        available: false,
        reason:
          'The preview runs in a sandbox without same-origin access, so its frames and layout cannot be measured from here. That isolation is deliberate.',
      },
    },
    {
      id: 'network',
      label: 'Application network timing',
      value: null,
      unit: 'ms',
      availability: {
        available: false,
        reason:
          'Requests your application makes happen inside the sandboxed preview and are not visible to this page.',
      },
    },
  ];
}

export interface BundleBreakdown {
  js: number;
  css: number;
  html: number;
  total: number;
  externals: number;
}

export function breakdownOf(sample: BuildSample): BundleBreakdown {
  return {
    js: sample.js,
    css: sample.css,
    html: sample.html,
    total: sample.js + sample.css + sample.html,
    externals: sample.externals,
  };
}

export interface Trend {
  /** The change from the previous successful build, in the same unit. */
  delta: number;
  /** Percentage change, or null when the previous value was zero. */
  percent: number | null;
}

/**
 * How this build compares with the one before it.
 *
 * Only against the previous *successful* build: a failed build produced no
 * bundle, and comparing against its zero would report every recovery as a
 * hundred-percent regression.
 */
export function trendBetween(samples: BuildSample[], pick: (sample: BuildSample) => number): Trend | null {
  const successful = samples.filter((sample) => sample.ok);
  if (successful.length < 2) return null;
  const [latest, previous] = successful;
  const delta = pick(latest) - pick(previous);
  const base = pick(previous);
  return { delta, percent: base === 0 ? null : Math.round((delta / base) * 100) };
}

export interface Recommendation {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

/** Thresholds, stated rather than hidden, so a reader can disagree with them. */
export const THRESHOLDS = {
  /** Above this, a bundle is worth looking at on a slow connection. */
  largeBundleBytes: 500 * 1024,
  /** Above this, the edit-to-preview loop stops feeling immediate. */
  slowBuildMs: 3_000,
  /** Each external is a separate CDN request before the app can run. */
  manyExternals: 8,
  /** A single build growing by more than this is worth explaining. */
  growthPercent: 20,
} as const;

/**
 * What to do about it, from the measurements and nothing else.
 *
 * Every recommendation names the number that produced it. A profiler that
 * advises without showing its reading is asking to be trusted rather than
 * checked.
 */
export function recommendationsFor(samples: BuildSample[]): Recommendation[] {
  const latest = samples.find((sample) => sample.ok);
  if (!latest) return [];

  const out: Recommendation[] = [];
  const breakdown = breakdownOf(latest);

  if (breakdown.total > THRESHOLDS.largeBundleBytes) {
    out.push({
      id: 'large-bundle',
      severity: 'medium',
      title: `The bundle is ${formatBytes(breakdown.total)}`,
      detail: `Above ${formatBytes(THRESHOLDS.largeBundleBytes)}, this is worth splitting: load the parts a first screen does not need on demand instead.`,
    });
  }

  if (latest.durationMs > THRESHOLDS.slowBuildMs) {
    out.push({
      id: 'slow-build',
      severity: 'medium',
      title: `Builds take ${latest.durationMs}ms`,
      detail: `Past ${THRESHOLDS.slowBuildMs}ms the edit-to-preview loop stops feeling immediate. Large dependencies pulled in from an entry file are the usual cause.`,
    });
  }

  if (latest.externals > THRESHOLDS.manyExternals) {
    out.push({
      id: 'many-externals',
      severity: 'low',
      title: `${latest.externals} packages come from a CDN at run time`,
      detail:
        'Each is a separate request the preview makes before your application can run, and each depends on that CDN being reachable.',
    });
  }

  const sizeTrend = trendBetween(samples, (sample) => sample.js + sample.css + sample.html);
  if (sizeTrend && sizeTrend.percent !== null && sizeTrend.percent > THRESHOLDS.growthPercent) {
    out.push({
      id: 'growing',
      severity: 'high',
      title: `The bundle grew ${sizeTrend.percent}% since the previous build`,
      detail: `That is ${formatBytes(Math.abs(sizeTrend.delta))} more than last time. A jump this size usually means a dependency was added to a path that runs on load.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
