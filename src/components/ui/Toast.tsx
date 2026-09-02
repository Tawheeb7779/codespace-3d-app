import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import type { ToastMessage } from '@/types';
import { cx } from '@/lib/utils';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TONES = {
  info: 'text-accent',
  success: 'text-positive',
  warning: 'text-caution',
  error: 'text-danger',
};

function Toast({ toast }: { toast: ToastMessage }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = ICONS[toast.variant];

  useEffect(() => {
    if (!toast.duration) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] animate-slide-up items-start gap-2.5',
        'rounded-lg border border-line bg-surface-overlay p-3 shadow-pop',
      )}
    >
      <Icon aria-hidden className={cx('mt-0.5 h-4 w-4 shrink-0', TONES[toast.variant])} />
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-ink">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 break-words text-sm text-ink-muted">{toast.description}</p>
        )}
        {toast.action && (
          <Button
            size="xs"
            variant="outline"
            className="mt-2"
            onClick={() => {
              dismiss(toast.id);
              toast.action?.run();
            }}
          >
            {toast.action.label}
          </Button>
        )}
      </div>
      <IconButton
        label="Dismiss notification"
        icon={<X className="h-3.5 w-3.5" />}
        size="xs"
        tooltip={false}
        onClick={() => dismiss(toast.id)}
      />
    </div>
  );
}

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div
      aria-live="polite"
      // bottom-9 clears the 24px status bar without covering it.
      className="pointer-events-none fixed bottom-9 right-4 z-[95] flex flex-col items-end gap-2"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
