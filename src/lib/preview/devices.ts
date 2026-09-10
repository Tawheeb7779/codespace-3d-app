/**
 * Viewports to test a layout against.
 *
 * The sizes are real CSS viewport dimensions for devices people actually have,
 * not round numbers: 390×844 is an iPhone 14, and a layout that works at 400
 * and breaks at 390 is a layout that breaks. Where a size is shared by several
 * devices they are named together rather than listed twice — this is a list of
 * *widths worth checking*, and padding it with duplicates makes it worse.
 *
 * `responsive` is the panel's own width, which is the one to work in; the
 * fixed sizes are for checking, and the difference matters enough to be first
 * in the list rather than a mode.
 */

export interface DevicePreset {
  id: string;
  label: string;
  /** Portrait dimensions. Landscape swaps them. */
  width: number;
  height: number;
  group: 'phone' | 'tablet' | 'desktop';
  /** Whether turning it makes sense. A desktop monitor does not rotate. */
  rotatable: boolean;
}

/**
 * The one viewport that is not a size: the panel itself.
 *
 * Kept as the id `desktop` because that is what the store has always called it
 * and what it defaults to. Renaming it would change persisted and in-flight
 * state for no benefit a person would notice.
 */
export const RESPONSIVE_ID = 'desktop';

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'desktop', label: 'Responsive', width: 0, height: 0, group: 'desktop', rotatable: false },

  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, group: 'phone', rotatable: true },
  // The store's original `mobile`, kept as an id so nothing that set it breaks.
  { id: 'mobile', label: 'iPhone 14 / Pixel 7', width: 390, height: 844, group: 'phone', rotatable: true },
  { id: 'iphone-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, group: 'phone', rotatable: true },
  { id: 'galaxy-s', label: 'Galaxy S22', width: 360, height: 780, group: 'phone', rotatable: true },

  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133, group: 'tablet', rotatable: true },
  // The store's original `tablet`.
  { id: 'tablet', label: 'iPad Air', width: 834, height: 1112, group: 'tablet', rotatable: true },
  { id: 'ipad-pro', label: 'iPad Pro 12.9"', width: 1024, height: 1366, group: 'tablet', rotatable: true },

  { id: 'laptop', label: 'Laptop', width: 1280, height: 800, group: 'desktop', rotatable: false },
  { id: 'desktop-hd', label: 'Desktop', width: 1440, height: 900, group: 'desktop', rotatable: false },
];

export type Orientation = 'portrait' | 'landscape';

/** Smallest and largest a custom viewport may be, so the frame stays usable. */
export const CUSTOM_LIMITS = { min: 200, max: 3840 } as const;

export function presetById(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id);
}

export interface Viewport {
  /** 0 means "as wide as the panel". */
  width: number;
  height: number;
  /** What to show beside the toolbar. */
  label: string;
  responsive: boolean;
}

/**
 * The size to render at.
 *
 * Custom dimensions win when set, then the preset, and `responsive` collapses
 * to zero so the caller can let the frame fill its container rather than
 * inventing a number for it.
 */
export function viewportFor(
  presetId: string,
  orientation: Orientation,
  custom: { width: number; height: number } | null,
): Viewport {
  if (custom) {
    const width = clampDimension(custom.width);
    const height = clampDimension(custom.height);
    return { width, height, label: `${width} × ${height}`, responsive: false };
  }

  const preset = presetById(presetId) ?? presetById(RESPONSIVE_ID)!;
  if (preset.width === 0) return { width: 0, height: 0, label: 'Responsive', responsive: true };

  const landscape = orientation === 'landscape' && preset.rotatable;
  const width = landscape ? preset.height : preset.width;
  const height = landscape ? preset.width : preset.height;
  return { width, height, label: `${width} × ${height}`, responsive: false };
}

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return CUSTOM_LIMITS.min;
  return Math.min(CUSTOM_LIMITS.max, Math.max(CUSTOM_LIMITS.min, Math.round(value)));
}

/**
 * How much to shrink the frame so it fits.
 *
 * A 1440-wide viewport in a 500-wide panel is not a preview, it is a scrollbar.
 * Scaling down shows the whole layout at once, which is the question being
 * asked — and never scaling *up* keeps a phone viewport life-size rather than
 * blowing 390px across a monitor and misrepresenting how big the text is.
 *
 * Returns 1 when the frame already fits or when there is nothing to measure.
 */
export function fitScale(
  viewport: { width: number; height: number },
  container: { width: number; height: number },
): number {
  if (!viewport.width || !viewport.height) return 1;
  if (!container.width || !container.height) return 1;
  const scale = Math.min(container.width / viewport.width, container.height / viewport.height);
  if (!Number.isFinite(scale) || scale >= 1) return 1;
  // Two decimals: a scale of 0.7231 renders text at fractional pixels for no
  // visible gain over 0.72.
  return Math.max(0.1, Math.round(scale * 100) / 100);
}
