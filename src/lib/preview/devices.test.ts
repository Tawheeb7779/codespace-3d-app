import { beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_LIMITS,
  DEVICE_PRESETS,
  clampDimension,
  fitScale,
  presetById,
  viewportFor,
} from '@/lib/preview/devices';
import { usePreviewStore } from '@/stores/previewStore';

/**
 * Checking a layout at a size it will actually meet.
 *
 * The sizes are real device viewports rather than round numbers, because the
 * bug being hunted is the one that appears at 390 and not at 400. So the list
 * has to stay real, the rotation has to swap the axes rather than approximate
 * them, and a custom size has to be the size that was typed.
 *
 * The other property is that the frame is *scaled*, never resized, when it does
 * not fit: the page inside must still see the viewport it is being tested at,
 * or the test is of a different layout than the one being asked about.
 */

beforeEach(() => {
  usePreviewStore.setState({ device: 'desktop', orientation: 'portrait', customViewport: null });
});

describe('the preset list', () => {
  /** Anything that set one of the original three must keep working. */
  it.each(['desktop', 'tablet', 'mobile'])('still has the original id %s', (id) => {
    expect(presetById(id)).toBeDefined();
  });

  it('keeps responsive as a viewport with no size of its own', () => {
    expect(presetById('desktop')?.width).toBe(0);
  });

  it('has no duplicate ids', () => {
    const ids = DEVICE_PRESETS.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers phones, tablets and desktops', () => {
    const groups = new Set(DEVICE_PRESETS.map((preset) => preset.group));

    expect(groups).toEqual(new Set(['phone', 'tablet', 'desktop']));
  });

  /** The narrow widths are the point; a list that starts at 400 finds nothing. */
  it('includes a viewport at 375 or narrower', () => {
    const narrowest = Math.min(
      ...DEVICE_PRESETS.filter((preset) => preset.width > 0).map((preset) => preset.width),
    );

    expect(narrowest).toBeLessThanOrEqual(375);
  });
});

describe('resolving a viewport', () => {
  it('gives responsive no dimensions, so the frame fills its panel', () => {
    const viewport = viewportFor('desktop', 'portrait', null);

    expect(viewport.responsive).toBe(true);
    expect(viewport.width).toBe(0);
  });

  it('reports a preset at its real size', () => {
    const viewport = viewportFor('mobile', 'portrait', null);

    expect(viewport).toMatchObject({ width: 390, height: 844, responsive: false });
  });

  it('swaps the axes when turned, rather than guessing a landscape size', () => {
    const portrait = viewportFor('mobile', 'portrait', null);
    const landscape = viewportFor('mobile', 'landscape', null);

    expect(landscape.width).toBe(portrait.height);
    expect(landscape.height).toBe(portrait.width);
  });

  /** A monitor does not rotate, and pretending otherwise is a nonsense size. */
  it('ignores rotation for something that does not rotate', () => {
    const viewport = viewportFor('desktop-hd', 'landscape', null);

    expect(viewport).toMatchObject({ width: 1440, height: 900 });
  });

  it('uses the size that was typed, over the preset', () => {
    const viewport = viewportFor('mobile', 'portrait', { width: 412, height: 915 });

    expect(viewport).toMatchObject({ width: 412, height: 915 });
  });

  it('falls back to responsive for a preset that no longer exists', () => {
    const viewport = viewportFor('a-phone-from-2009', 'portrait', null);

    expect(viewport.responsive).toBe(true);
  });
});

describe('a size somebody typed', () => {
  it.each([
    [0, CUSTOM_LIMITS.min],
    [-500, CUSTOM_LIMITS.min],
    [99_999, CUSTOM_LIMITS.max],
    [Number.NaN, CUSTOM_LIMITS.min],
  ])('clamps %j to %i', (input, expected) => {
    expect(clampDimension(input)).toBe(expected);
  });

  it('keeps a reasonable size exactly', () => {
    expect(clampDimension(412)).toBe(412);
  });

  it('rounds a fractional size rather than rendering at half a pixel', () => {
    expect(clampDimension(412.6)).toBe(413);
  });
});

describe('fitting a frame into the panel', () => {
  it('shrinks a viewport wider than the panel', () => {
    const scale = fitScale({ width: 1440, height: 900 }, { width: 720, height: 900 });

    expect(scale).toBeCloseTo(0.5, 2);
  });

  /** Blowing a 390px phone across a monitor misrepresents how big its text is. */
  it('never grows a viewport that already fits', () => {
    expect(fitScale({ width: 390, height: 844 }, { width: 1200, height: 1000 })).toBe(1);
  });

  it('fits the taller constraint too, not only the wider one', () => {
    const scale = fitScale({ width: 400, height: 1000 }, { width: 4000, height: 500 });

    expect(scale).toBeCloseTo(0.5, 2);
  });

  it('does not divide by an unmeasured panel', () => {
    expect(fitScale({ width: 1440, height: 900 }, { width: 0, height: 0 })).toBe(1);
  });

  it('leaves a responsive frame alone', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 500, height: 500 })).toBe(1);
  });
});

describe('the preview store', () => {
  it('resolves the viewport from the preset it was given', () => {
    usePreviewStore.getState().setDevice('ipad-pro');

    expect(usePreviewStore.getState().viewport()).toMatchObject({ width: 1024, height: 1366 });
  });

  /** Otherwise clicking a preset appears to do nothing. */
  it('clears a typed size when a preset is chosen', () => {
    usePreviewStore.getState().setCustomViewport({ width: 500, height: 500 });

    usePreviewStore.getState().setDevice('mobile');

    expect(usePreviewStore.getState().customViewport).toBeNull();
    expect(usePreviewStore.getState().viewport().width).toBe(390);
  });

  it('clamps a typed size on the way in, not only on the way out', () => {
    usePreviewStore.getState().setCustomViewport({ width: 10, height: 99_999 });

    expect(usePreviewStore.getState().customViewport).toEqual({
      width: CUSTOM_LIMITS.min,
      height: CUSTOM_LIMITS.max,
    });
  });

  it('goes back to the preset when the typed size is cleared', () => {
    usePreviewStore.getState().setDevice('tablet');
    usePreviewStore.getState().setCustomViewport({ width: 500, height: 500 });

    usePreviewStore.getState().setCustomViewport(null);

    expect(usePreviewStore.getState().viewport().width).toBe(834);
  });

  it('turns the current preset without losing it', () => {
    usePreviewStore.getState().setDevice('mobile');
    usePreviewStore.getState().setOrientation('landscape');

    expect(usePreviewStore.getState().viewport()).toMatchObject({ width: 844, height: 390 });
    expect(usePreviewStore.getState().device).toBe('mobile');
  });
});
