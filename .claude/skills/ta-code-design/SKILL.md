---
name: ta-code-design
description: TA CODE's design system — tokens, surface hierarchy, type scale, motion, the two-pointer interaction model, and the accessibility rules the audits enforce. Use when changing any UI in this repository: adding or restyling a component, touching colour, spacing, radii or motion, working on responsive or touch behaviour, or reviewing a UI diff.
---

# TA CODE design system

The product is a browser IDE. It is dense where a cursor is and roomy where a
thumb is, and those are two expressions of one design — not two designs.

Everything below is already implemented. This file exists so a change can be
checked against the system instead of guessed at. **The source of truth is
`src/index.css` and `tailwind.config.js`; if this file disagrees with them, they
are right and this file is stale.**

## Never do these

- **Never write a raw colour** (`#1a1a1a`, `rgb(...)`, `text-gray-400`) in a
  component. Every colour is a token. A raw value cannot follow the theme and
  will not be seen by the contrast audit.
- **Never add a colour token without running `npm run audit:contrast`.** It
  fails the build on a WCAG miss and on an accent that drifts too close in hue
  to a status colour.
- **Never put a bare text node next to a conditionally-rendered element.**
  `npm run audit:reconciliation` scans for this. Chrome Translate and Grammarly
  replace text nodes, React's stored reference goes stale, and removal throws
  `NotFoundError`. Wrap the text in a `<span>`.
- **Never grow a control's painted size to make it tappable.** Add
  `tap-target` (see Pointer model).
- **Never gate an affordance on viewport width when the real question is the
  input device.** `useIsMobile()` chooses a layout; `useIsTouch()` decides
  whether an affordance exists at all.

## Colour

Thirteen tokens, defined twice — `:root`/`[data-theme='forge-dark']` and
`[data-theme='forge-light']` in `src/index.css` — and exposed to Tailwind as
channel triples so `bg-surface/60` keeps working.

Surfaces are neutral graphite, not blue-black. A blue cast on every panel is
what makes a dark UI read as generic; removing it means the only saturated
things on screen are the ones that mean something.

| Token | Role |
|---|---|
| `canvas` | the ground the frame sits on |
| `surface` | the frame itself: bars, panels, cards |
| `surface-raised` | a row you are pointing at |
| `surface-sunken` | content *under* the frame: gutters, wells, inputs |
| `surface-overlay` | floating above everything: menus, tooltips |
| `line` / `line-strong` | hairlines; strong is for a divider that must be seen |
| `ink` / `ink-muted` / `ink-faint` | primary, secondary, and quietest text |
| `accent` / `accent-soft` / `accent-ink` | one accent: focus, selection, primary action |
| `positive` / `caution` / `danger` | status only |

Depth comes from those five surface steps, not from shadow. Each step is a small
luminance move. In light theme `raised` is a step *down*, because on white there
is nowhere brighter to go.

The accent sits near 196°, a cyan-leaning signal blue, held ≥25° from every
status colour by the audit — an accent sharing a hue with a status is a control
that looks like a verdict.

## Type

Inter for UI, JetBrains Mono for code and terminal. Body is 13px/20px: this is
an IDE, and 16px body would cost the density that makes a tree and a status bar
readable.

Scale (`tailwind.config.js`): `2xs` 10 · `xs` 11 · `sm` 12 · `base` 13 · `md` 14
· `lg` 16 · `xl` 20 · `2xl` 26 · `3xl` 34 · `4xl` 46 · `5xl` 60. Negative
tracking increases with size.

Use `tabular-nums` for any number that changes in place — cursor position, build
timings, counts. Proportional digits shift the layout around them.

## Shape, depth, motion

Radii: 4 / 6 (default) / 10 / 14. Shadows: `panel`, `pop` (menus, dialogs),
`glow` (accent emphasis) — restrained by design; depth is luminance.

Motion is 140–180ms on `cubic-bezier(0.16, 1, 0.3, 1)`, with `fade-in`,
`scale-in`, `slide-up`, `slide-right`, `shimmer`, `spin`. Reduced motion is
honoured twice: `prefers-reduced-motion` and a `[data-reduced-motion]` setting.
Animate one or two elements per view; never animate `width`/`height`/`top`.

## Pointer model

Two interaction models, one product. Density is not a compromise to be split
down the middle — it is resolved per pointer.

- **`tap-target`** (`src/index.css`) grows a control's *hit* area to 32px under
  `@media (pointer: coarse)` via a centred transparent `::after`. The painted
  control never changes size, and desktop is untouched (`content: none`). Put it
  on any control under 24px. `IconButton`/`IconLink` already carry it.
- **Form text is 16px under `pointer: coarse`.** Not a preference: iOS Safari
  zooms the page when an input under 16px is focused, and does not zoom back.
  Monaco and xterm are excluded — both measure their caret from a hidden input's
  font, so an imposed size moves the cursor.
- **The mobile workspace is one pane** from a five-item bottom navigation, and
  reads `mobilePane`. It ignores `sidebarOpen` / `bottomOpen` / `previewOpen`.
  A control that only writes those is dead on a phone: hide it (`useIsMobile()`)
  or make it navigate. `setSidebarPanel` and `setBottomTab` already bring the
  matching pane forward, so prefer them to setting layout flags by hand.
- **Tooltips are keyboard-and-hover only.** `Tooltip` checks `:focus-visible`,
  so a tap does not summon one.

Verify changes at 320 / 375 / 390 / 430 / 768 / 1024 / 1440, in both themes.
The bar is: no horizontal scroll, no control clipped out of reach, no label
truncated to nothing, no dead control.

## Accessibility

WCAG 2.2 AA is the floor, and two audits enforce parts of it in CI.

- Contrast 4.5:1 for text, 3:1 for UI, measured by `npm run audit:contrast`.
- Focus is a 2px accent outline via `:focus-visible`. Never remove it.
- Pointer targets 24×24 CSS px (the *web* threshold — 44px is the native one).
  A small control inside a `<label>` is fine: the label is the target.
- Icon-only controls must have a name; `IconButton` requires `label`.
- Errors sit next to their field, wired with `aria-describedby` and
  `role="alert"` (`Field`). Toasts use `aria-live="polite"` and never take focus.
- Don't convey meaning by colour alone — pair it with an icon or text.

## Components

Reuse before you build. `src/components/ui/` has Button, IconButton/IconLink,
Field (Input/Textarea/Select/Switch/Checkbox), Modal, Menu, Toast, Tooltip,
Resizer, Primitives (Badge, EmptyState, ErrorState, Spinner, SkeletonRows, Kbd,
PanelHeader), Wordmark. `src/components/ide/` has the workspace surfaces.

Put shared behaviour in the primitive, not at the call sites — the password
reveal, the tap target and the tooltip focus rule are all one place each. Extract
a new primitive only when duplication is real, not anticipated.

## Using an external component library

21st.dev is **blocked by the network egress proxy in the Claude Code
environment** (403 on CONNECT), so it has not been used. Its CLI's skill is
public on GitHub and was used as a rules dataset only.

If such a source becomes reachable: take the *pattern* — layout, states, the
interaction — and rebuild it on these tokens and primitives. Do not import a
second design system, a second palette, or a component that brings its own
colours. A screen that does not share this file's tokens will read as a
different product.

## Before you push

`npm run verify` — typecheck, lint, both audits, unit tests, production build.
Browser suites are `e2e/*.mjs`; `e2e/agent.mjs` needs
`npm run agent:test-provider` and `e2e/github.mjs` needs
`npm run github:test-api` running first.
