import { Users, Wifi, WifiOff } from 'lucide-react';
import { Switch } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Primitives';
import { useCollabStore } from '@/stores/collabStore';
import { isSupabaseConfigured } from '@/lib/supabase';
import { cx } from '@/lib/utils';

/**
 * Editing together, and an honest account of whether it is working.
 *
 * The switch is off until somebody turns it on, because shared editing changes
 * what a keystroke means: it leaves the machine. What is underneath is the
 * status of the file on screen, and it distinguishes the three things that
 * would otherwise look identical — synchronised, still working out whether a
 * peer holds this file, and a channel that failed and left this tab editing
 * alone. Only the first of those is collaboration, and only it says so.
 */
export function CollabToggle() {
  const { enabled, status, detail, peers, setEnabled } = useCollabStore();

  if (!isSupabaseConfigured) {
    return (
      <p className="px-2.5 pb-2 text-sm text-ink-faint">
        <span>
          Shared editing needs a Supabase project. In local development mode this workspace is
          yours alone.
        </span>
      </p>
    );
  }

  return (
    <div className="border-t border-line px-2.5 py-2">
      <Switch
        label="Edit together"
        description="Share the open file with whoever else has this project open."
        checked={enabled}
        onChange={setEnabled}
      />

      {enabled && (
        <div className="mt-1.5 flex items-start gap-1.5 text-sm">
          {status === 'bootstrapping' ? (
            <Spinner className="mt-0.5 h-3 w-3" />
          ) : status === 'connected' ? (
            <Wifi aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-positive" />
          ) : (
            <WifiOff
              aria-hidden
              className={cx('mt-0.5 h-3 w-3 shrink-0', status === 'error' ? 'text-danger' : '')}
            />
          )}
          <span className={cx('min-w-0 flex-1', status === 'error' ? 'text-danger' : 'text-ink-faint')}>
            {status === 'connected'
              ? peers.length
                ? `Sharing this file with ${peers.length} other ${peers.length === 1 ? 'person' : 'people'}.`
                : 'Sharing this file. Nobody else has it open.'
              : status === 'bootstrapping'
                ? 'Checking whether anyone else already has this file…'
                : status === 'error'
                  ? (detail ?? 'Not connected. Your edits are local only.')
                  : 'Open a file to share it.'}
          </span>
        </div>
      )}

      {enabled && peers.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {peers.map((peer) => (
            <li
              key={peer.clientId}
              className="flex items-center gap-1 rounded-sm border border-line px-1.5 py-px text-sm text-ink-muted"
            >
              {/* The same colour as their caret in the editor, which is the
                  only thing that ties a name in this list to a cursor. */}
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: peer.colour }}
              />
              <span className="truncate">{peer.displayName}</span>
            </li>
          ))}
        </ul>
      )}

      {enabled && status === 'connected' && (
        <p className="mt-1.5 flex items-start gap-1.5 text-sm text-ink-faint">
          <Users aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Only the open file is shared. Saving still writes to the project as it always has.
          </span>
        </p>
      )}
    </div>
  );
}
