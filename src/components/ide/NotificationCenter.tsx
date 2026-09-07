import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Primitives';
import { useToastStore, type NotificationRecord } from '@/stores/toastStore';
import { formatTimeAgo } from '@/lib/utils';
import { cx } from '@/lib/utils';

/**
 * What the toasts said, after they have gone.
 *
 * A toast is an interruption with a four-second life, which is right while it
 * is happening and useless a minute later. Everything that was announced is
 * kept here — a failed push, a save that was refused, a build that finished
 * while the reader was elsewhere — so "what was that message?" has an answer.
 *
 * Nothing is invented for this list: it is the record of notifications the
 * application actually raised, in the order it raised them.
 */

const ICON: Record<NotificationRecord['variant'], typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const TONE: Record<NotificationRecord['variant'], string> = {
  info: 'text-ink-muted',
  success: 'text-positive',
  warning: 'text-caution',
  error: 'text-danger',
};

export function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const history = useToastStore((s) => s.history);
  const clearHistory = useToastStore((s) => s.clearHistory);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Notifications"
      size="md"
      footer={
        history.length > 0 ? (
          <Button leading={<Trash2 className="h-3.5 w-3.5" />} onClick={clearHistory}>
            Clear all
          </Button>
        ) : undefined
      }
    >
      {history.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-4 w-4" />}
          title="Nothing to catch up on"
          description="Builds, saves, commits and assistant results are recorded here as they happen."
        />
      ) : (
        <ul className="scrollbar-thin -mx-1 max-h-[26rem] overflow-y-auto px-1">
          {history.map((entry) => {
            const Glyph = ICON[entry.variant];
            return (
              <li
                key={entry.id}
                className="flex gap-2.5 border-b border-line py-2.5 last:border-0"
              >
                <Glyph aria-hidden className={cx('mt-0.5 h-4 w-4 shrink-0', TONE[entry.variant])} />
                <div className="min-w-0 flex-1">
                  <p className="text-base text-ink">{entry.title}</p>
                  {entry.description && (
                    <p className="mt-0.5 break-words text-sm text-ink-muted">{entry.description}</p>
                  )}
                </div>
                <time className="shrink-0 text-sm text-ink-faint">{formatTimeAgo(entry.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
