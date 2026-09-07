import { cx } from '@/lib/utils';

/**
 * The TA CODE mark.
 *
 * One component rather than three copies, because it had been pasted into the
 * landing header, the sign-in page and the dashboard at three sizes with three
 * sets of classes — which is how a logo drifts.
 *
 * The glyph is a caret over a baseline: the two marks a terminal shows you
 * before you have typed anything. It survives 16px, which a two-letter monogram
 * does not, and it says "this is where code is written" without a picture of a
 * tool. Strokes are geometric and joined square — the mark should look measured
 * rather than drawn.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cx('shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <path d="M7.5 7.5 12 12l-4.5 4.5" />
      <path d="M13.5 16.5h4" />
    </svg>
  );
}

/** Size steps, so a header never invents its own. */
const SIZES = {
  sm: { box: 'h-5 w-5 rounded', glyph: 'h-3.5 w-3.5', text: 'text-base' },
  md: { box: 'h-6 w-6 rounded', glyph: 'h-4 w-4', text: 'text-md' },
} as const;

/**
 * The mark and the name together, as they appear in a header.
 *
 * `TA` carries the weight and `CODE` is set lighter and wider beside it — the
 * name reads as one thing at a glance and as two words when you look at it,
 * which is what keeps a two-word product name from looking like a sentence.
 */
export function Wordmark({
  size = 'md',
  className,
}: {
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const step = SIZES[size];
  return (
    <span className={cx('flex items-center gap-2', className)}>
      <span
        className={cx(
          'flex items-center justify-center bg-accent text-accent-ink',
          step.box,
        )}
      >
        <Mark className={step.glyph} />
      </span>
      <span className={cx('font-semibold tracking-tight text-ink', step.text)}>
        TA{' '}
        <span className="font-medium tracking-[0.14em] text-ink-muted">CODE</span>
      </span>
    </span>
  );
}
