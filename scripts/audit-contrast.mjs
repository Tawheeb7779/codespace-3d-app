/**
 * Hold the palette to a contrast standard, instead of to an opinion.
 *
 * Every colour in `src/index.css` exists to be read against something, and the
 * pair is what has to pass — not the swatch. This parses the real theme blocks
 * out of the stylesheet and measures the pairs the interface actually renders:
 * body text on the canvas, muted labels on a panel, an accent fill's own text,
 * the semantic colours where they are used as text, and the focus ring against
 * everything it can land on.
 *
 * WCAG 2.1 thresholds: 4.5:1 for body text, 3:1 for large text and for the
 * non-text boundaries a control is recognised by. A design that misses these is
 * not a matter of taste — it is a defect, and this is where it fails.
 *
 *   node scripts/audit-contrast.mjs
 *
 * Exit code is 1 when a pair is below its threshold, so `verify` can gate on it.
 */
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';

const css = readFileSync('src/index.css', 'utf8');

/** Pull one theme's custom properties out of the stylesheet. */
function readTheme(selector) {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`no ${selector} block in src/index.css`);
  const block = css.slice(at, css.indexOf('}', at));
  const tokens = {};
  for (const match of block.matchAll(/--(c-[a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return tokens;
}

/** Relative luminance, per WCAG 2.1. */
const luminance = ([r, g, b]) => {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
  const [light, dark] = luminance(a) >= luminance(b) ? [a, b] : [b, a];
  return (luminance(light) + 0.05) / (luminance(dark) + 0.05);
};

/**
 * The pairs the interface really puts next to each other.
 *
 * `min` is the WCAG threshold for that pair's role: 4.5 where the text is body
 * sized, 3 where it is large or is a boundary rather than text.
 */
const PAIRS = [
  ['c-ink', 'c-canvas', 4.5, 'body text on the workspace'],
  ['c-ink', 'c-surface', 4.5, 'body text on a panel'],
  ['c-ink', 'c-surface-raised', 4.5, 'body text on a raised row'],
  ['c-ink', 'c-surface-overlay', 4.5, 'body text in a dialog'],
  ['c-ink-muted', 'c-surface', 4.5, 'secondary text on a panel'],
  ['c-ink-muted', 'c-canvas', 4.5, 'secondary text on the workspace'],
  ['c-ink-faint', 'c-surface', 3, 'the quietest labels, which are all uppercase and small'],
  ['c-accent', 'c-canvas', 3, 'the focus ring and active markers on the workspace'],
  ['c-accent', 'c-surface', 3, 'the focus ring and active markers on a panel'],
  ['c-accent-ink', 'c-accent', 4.5, 'text on an accent fill'],
  ['c-accent', 'c-accent-soft', 3, 'an accent chip against its own tint'],
  ['c-positive', 'c-surface', 4.5, 'a success reading'],
  ['c-caution', 'c-surface', 4.5, 'a warning reading'],
  ['c-danger', 'c-surface', 4.5, 'an error reading'],
  ['c-danger', 'c-canvas', 4.5, 'an error reading on the workspace'],
  ['c-line-strong', 'c-surface', 1.4, 'a divider that has to be visible at all'],
];

/**
 * Colours that must not be mistaken for one another.
 *
 * The accent is the interface's "this is active"; the semantic three are
 * "this went well / take care / this is wrong". An accent that reads as a
 * status is a design bug, so they are held apart by hue.
 */
const DISTINCT = [
  ['c-accent', 'c-positive', 'the accent must not read as success'],
  ['c-accent', 'c-caution', 'the accent must not read as a warning'],
  ['c-accent', 'c-danger', 'the accent must not read as an error'],
  ['c-positive', 'c-caution', 'success and warning'],
  ['c-caution', 'c-danger', 'warning and error'],
];

/** Hue in degrees, for the separation check. */
const hue = ([r, g, b]) => {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === min) return 0;
  const d = max - min;
  const h =
    max === red
      ? ((green - blue) / d + (green < blue ? 6 : 0))
      : max === green
        ? (blue - red) / d + 2
        : (red - green) / d + 4;
  return h * 60;
};

const separation = (a, b) => {
  const delta = Math.abs(hue(a) - hue(b));
  return Math.min(delta, 360 - delta);
};

/** Hues closer than this are hard to tell apart at small sizes. */
const MIN_HUE_SEPARATION = 25;

let failures = 0;

for (const [selector, label] of [
  ["[data-theme='forge-dark']", 'dark'],
  ["[data-theme='forge-light']", 'light'],
]) {
  const theme = readTheme(selector);
  console.log(`\n${label}`);

  for (const [front, back, min, role] of PAIRS) {
    if (!theme[front] || !theme[back]) {
      console.log(`  MISSING  ${front} or ${back}`);
      failures += 1;
      continue;
    }
    const ratio = contrast(theme[front], theme[back]);
    const ok = ratio >= min;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1 (needs ${min}) — ${role}`,
    );
  }

  for (const [a, b, role] of DISTINCT) {
    const apart = separation(theme[a], theme[b]);
    const ok = apart >= MIN_HUE_SEPARATION;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${apart.toFixed(0).padStart(5)}° apart (needs ${MIN_HUE_SEPARATION}) — ${role}`,
    );
  }
}

console.log(
  failures ? `\n${failures} pair(s) below standard` : '\nevery pair meets its contrast threshold',
);
exit(failures ? 1 : 0);
