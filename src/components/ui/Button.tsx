import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
      {children}
      {trailing}
    </button>
  );
});
