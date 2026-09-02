import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '@/lib/utils';

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'positive' | 'caution' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'border-line text-ink-muted',
    accent: 'border-accent/40 bg-accent-soft text-accent',
    positive: 'border-positive/30 bg-positive/10 text-positive',
    caution: 'border-caution/30 bg-caution/10 text-caution',
    danger: 'border-danger/30 bg-danger/10 text-danger',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-2xs font-medium uppercase tracking-wider',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cx('h-4 w-4 animate-spin text-ink-faint', className)} />;
}

export function PanelHeader({
  title,
  actions,
  className,
}: {
  title: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line px-2.5',
        className,
      )}
    >
      <h2 className="panel-label truncate">{title}</h2>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && (
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-raised text-ink-faint">
          {icon}
        </div>
      )}
      <p className="text-base font-medium text-ink">{title}</p>
      {description && <p className="max-w-xs text-sm text-ink-faint">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = 'Retry',
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="m-3 rounded-lg border border-danger/40 bg-danger/5 p-3">
      <p className="text-base font-medium text-danger">{title}</p>
      {detail && <p className="mt-1 break-words font-mono text-sm text-ink-muted">{detail}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-line px-2 py-0.5 text-sm text-ink hover:border-line-strong"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton h-4" style={{ width: `${60 + ((index * 13) % 35)}%` }} />
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line bg-surface-raised px-1 py-px font-mono text-2xs text-ink-muted">
      {children}
    </kbd>
  );
}
