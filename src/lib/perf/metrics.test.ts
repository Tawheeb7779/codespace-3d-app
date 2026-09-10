import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THRESHOLDS,
  breakdownOf,
  formatBytes,
  memoryReading,
  recommendationsFor,
  startupReading,
  trendBetween,
  unavailableMeasurements,
  type BuildSample,
} from '@/lib/perf/metrics';

/**
 * A profiler is worth exactly as much as its numbers are real.
 *
 * So two properties are under test. Every reading is either a measurement or
 * explicitly unavailable — never a zero standing in for a thing that was not
 * measured, and never an estimate presented as an observation. And every
 * recommendation names the number that produced it, so it can be checked
 * rather than trusted.
 *
 * The trend has its own trap: comparing against a failed build, which produced
 * no bundle, would report every recovery as a hundred-percent regression.
 */

const sample = (over: Partial<BuildSample> = {}): BuildSample => ({
  at: Date.now(),
  durationMs: 100,
  js: 1000,
  css: 100,
  html: 500,
  externals: 2,
  ok: true,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reporting bytes', () => {
  it.each([
    [500, '500 B'],
    [2048, '2.0 kB'],
    [1024 * 1024 * 3, '3.00 MB'],
  ])('reads %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('what a build cost', () => {
  it('adds the parts the bundler actually emitted', () => {
    const breakdown = breakdownOf(sample({ js: 1000, css: 200, html: 300 }));

    expect(breakdown.total).toBe(1500);
    expect(breakdown.js).toBe(1000);
  });
});

describe('comparing builds', () => {
  it('reports nothing until there are two to compare', () => {
    expect(trendBetween([sample()], (entry) => entry.js)).toBeNull();
  });

  it('reports growth against the previous build', () => {
    const trend = trendBetween(
      [sample({ js: 1200 }), sample({ js: 1000 })],
      (entry) => entry.js,
    );

    expect(trend).toEqual({ delta: 200, percent: 20 });
  });

  it('reports a shrink as a negative change', () => {
    const trend = trendBetween([sample({ js: 800 }), sample({ js: 1000 })], (entry) => entry.js);

    expect(trend?.delta).toBe(-200);
  });

  /**
   * A failed build produced no bundle. Comparing against its zero would make
   * every recovery look like an infinite regression.
   */
  it('ignores failed builds when comparing', () => {
    const trend = trendBetween(
      [sample({ js: 1000 }), sample({ js: 0, ok: false }), sample({ js: 1000 })],
      (entry) => entry.js,
    );

    expect(trend).toEqual({ delta: 0, percent: 0 });
  });

  it('reports no percentage when the previous value was zero', () => {
    const trend = trendBetween([sample({ css: 100 }), sample({ css: 0 })], (entry) => entry.css);

    expect(trend?.percent).toBeNull();
    expect(trend?.delta).toBe(100);
  });
});

describe('recommendations', () => {
  it('says nothing when there is nothing measured', () => {
    expect(recommendationsFor([])).toEqual([]);
  });

  it('says nothing about a small, fast build', () => {
    expect(recommendationsFor([sample({ js: 1000, durationMs: 50, externals: 1 })])).toEqual([]);
  });

  /** Each recommendation carries the reading that produced it. */
  it('names the size it is complaining about', () => {
    const found = recommendationsFor([sample({ js: THRESHOLDS.largeBundleBytes + 1 })]);

    expect(found[0].id).toBe('large-bundle');
    expect(found[0].title).toMatch(/\d/);
  });

  it('names the build time it is complaining about', () => {
    const found = recommendationsFor([sample({ durationMs: THRESHOLDS.slowBuildMs + 1 })]);

    expect(found.some((entry) => entry.id === 'slow-build')).toBe(true);
  });

  it('counts the packages fetched from a CDN at run time', () => {
    const found = recommendationsFor([sample({ externals: THRESHOLDS.manyExternals + 1 })]);

    expect(found.some((entry) => entry.id === 'many-externals')).toBe(true);
  });

  it('raises sudden growth above everything else', () => {
    const found = recommendationsFor([
      sample({ js: 3000, durationMs: THRESHOLDS.slowBuildMs + 1 }),
      sample({ js: 1000 }),
    ]);

    expect(found[0].id).toBe('growing');
    expect(found[0].severity).toBe('high');
  });

  it('does not complain about growth within the threshold', () => {
    const found = recommendationsFor([sample({ js: 1050 }), sample({ js: 1000 })]);

    expect(found.some((entry) => entry.id === 'growing')).toBe(false);
  });
});

describe('memory', () => {
  it('reports the reading when the browser offers one', () => {
    vi.stubGlobal('performance', {
      ...performance,
      memory: { usedJSHeapSize: 12_345_678, jsHeapSizeLimit: 100_000_000 },
    });

    const reading = memoryReading();

    expect(reading.availability.available).toBe(true);
    expect(reading.value).toBe(12_345_678);
  });

  /** Firefox and Safari do not have it, and there is no substitute. */
  it('says why there is no reading rather than reporting zero', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [] });

    const reading = memoryReading();

    expect(reading.value).toBeNull();
    expect(reading.availability.available).toBe(false);
    if (!reading.availability.available) {
      expect(reading.availability.reason).toMatch(/non-standard|does not provide/i);
    }
  });

  /**
   * The number is the whole tab — Monaco, esbuild and the preview included —
   * and would otherwise be read as the user's application.
   */
  it('says what the number actually covers', () => {
    vi.stubGlobal('performance', { ...performance, memory: { usedJSHeapSize: 1 } });

    expect(memoryReading().note).toMatch(/whole tab|not your application/i);
  });
});

describe('startup', () => {
  it('reports navigation timing when the browser has it', () => {
    vi.stubGlobal('performance', {
      getEntriesByType: () => [{ domContentLoadedEventEnd: 812 }],
    });

    const reading = startupReading();

    expect(reading.value).toBe(812);
    expect(reading.availability.available).toBe(true);
  });

  /** It measures the IDE starting, which is not the user's application. */
  it('says which thing it timed', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [{ domContentLoadedEventEnd: 1 }] });

    expect(startupReading().note).toMatch(/TA CODE|not how long your application/i);
  });

  it('reports unavailable rather than zero when there is no timing', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [] });

    const reading = startupReading();

    expect(reading.value).toBeNull();
    expect(reading.availability.available).toBe(false);
  });
});

describe('what cannot be measured here', () => {
  /**
   * A profiler that shows six panels and quietly omits CPU reads as though CPU
   * were fine. These are listed, with reasons.
   */
  it('lists the gaps rather than hiding them', () => {
    const gaps = unavailableMeasurements();

    expect(gaps.map((entry) => entry.id).sort()).toEqual(['cpu', 'network', 'render']);
    for (const gap of gaps) {
      expect(gap.value).toBeNull();
      expect(gap.availability.available).toBe(false);
    }
  });

  it('explains that CPU profiling has no API a page can call', () => {
    const cpu = unavailableMeasurements().find((entry) => entry.id === 'cpu');

    if (cpu && !cpu.availability.available) {
      expect(cpu.availability.reason).toMatch(/cannot start the browser|no API/i);
    }
  });

  /** The isolation is deliberate, and the reason says so. */
  it('attributes the preview gaps to the sandbox rather than to an oversight', () => {
    const render = unavailableMeasurements().find((entry) => entry.id === 'render');

    if (render && !render.availability.available) {
      expect(render.availability.reason).toMatch(/sandbox|same-origin/i);
      expect(render.availability.reason).toMatch(/deliberate/i);
    }
  });
});
