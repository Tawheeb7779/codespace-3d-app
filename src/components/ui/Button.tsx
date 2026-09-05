import { Children, forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent/90 active:bg-accent/80 disabled:bg-accent/40 font-medium',
  secondary:
    'bg-surface-raised text-ink border border-line hover:border-line-strong hover:bg-surface-overlay active:bg-surface',
  outline: 'border border-line text-ink-muted hover:text-ink hover:border-line-strong bg-transparent',
  ghost: 'text-ink-muted hover:text-ink hover:bg-surface-raised bg-transparent',
  danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/80 font-medium',
};

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-sm',
  sm: 'h-7 px-2.5 text-sm gap-1.5',
  md: 'h-8 px-3 text-base gap-2',
  lg: 'h-10 px-4 text-md gap-2 rounded-lg',
};

/**
 * Give every piece of label text an element of its own.
 *
 * The spinner is rendered into the slot immediately before the label, so React
 * commits it with `insertBefore(icon, label)`. When the label is a bare text
 * node, anything that rewrites text in the page — Chrome's translate, a
 * password manager, Grammarly, an accessibility overlay — replaces that node,
 * and React's reference to it is stale by the time `loading` flips. The commit
 * then throws "The node before which the new node is to be inserted is not a
 * child of this node" and the whole tree falls to the error boundary.
 *
 * Wrapping the text in a span makes React's reference an element instead.
 * Those layers rewrite the text *inside* an element rather than replacing the
 * element, so the reference stays valid. A span is also exactly what an
 * anonymous text run already was in this flex row, so nothing moves: element
 * children are left untouched and keep being their own flex items.
 */
function withStableText(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? <span>{child}</span> : child,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, leading, trailing, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Buttons inside forms default to submit; almost every usage here is an action.
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center whitespace-nowrap rounded transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" /> : leading}
      {withStableText(children)}
      {trailing}
    </button>
  );
});
