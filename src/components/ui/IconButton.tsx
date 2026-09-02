import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls must expose a name to assistive tech. */
  label: string;
  icon: ReactNode;
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
  tone?: 'default' | 'danger';
  /** Set false to skip the tooltip when the parent already labels the control. */
  tooltip?: boolean;
}

const SIZES = {
  xs: 'h-5 w-5',
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'sm', active, tone = 'default', tooltip = true, className, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      aria-label={label}
      aria-pressed={active !== undefined ? active : undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-40',
        SIZES[size],
        tone === 'danger'
          ? 'text-ink-muted hover:bg-danger/15 hover:text-danger'
          : active
            ? 'bg-accent-soft text-accent'
            : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );

  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
});
