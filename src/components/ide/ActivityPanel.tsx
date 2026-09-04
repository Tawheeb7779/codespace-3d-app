import { useEffect, useMemo } from 'react';
import { History, Users, Wifi, WifiOff } from 'lucide-react';
import { PanelHeader, EmptyState, Badge, Spinner, ErrorState } from '@/components/ui/Primitives';
import { useActivityStore } from '@/stores/activityStore';
import { usePresenceStore, statusFor } from '@/stores/presenceStore';
import { useFileStore } from '@/stores/fileStore';
import { useAuthStore } from '@/stores/authStore';
import { useEditorStore } from '@/stores/editorStore';
import { describeActivity } from '@/lib/activity';
import { formatTimeAgo } from '@/lib/utils';

/**
 * Who is here, and what has happened.
 *
 * The presence half is deliberately modest: Forge has no realtime transport,
 * so the only participant it can honestly report is this tab. The panel says
 * so in as many words rather than implying an empty list means nobody else is
 * working — those are very different claims.
 */
export function ActivityPanel() {
  const projectId = useFileStore((s) => s.projectId);
  const user = useAuthStore((s) => s.user);
  const activePath = useEditorStore((s) => s.activePath);

  const events = useActivityStore((s) => s.events);
  const loading = useActivityStore((s) => s.loading);
  const error = useActivityStore((s) => s.error);
  const load = useActivityStore((s) => s.load);

  const enter = usePresenceStore((s) => s.enter);
  const touch = usePresenceStore((s) => s.touch);
  const transport = usePresenceStore((s) => s.transport);
  // Same reason as the workspace list: a selector returning a new array on
  // every call never compares equal, and the component never stops updating.
  const self = usePresenceStore((s) => s.self);
  const remote = usePresenceStore((s) => s.remote);
  const participants = useMemo(() => (self ? [self, ...remote] : remote), [self, remote]);

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  useEffect(() => {
    if (projectId && user) enter(projectId, user);
  }, [projectId, user, enter]);

  useEffect(() => {
    touch(activePath);
  }, [activePath, touch]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Activity" />

      <section className="border-b border-line">
        <p className="panel-label flex items-center gap-1.5 px-2.5 py-1.5">
          <Users aria-hidden className="h-3 w-3" />
          In this project
        </p>
        {participants.map((participant) => {
          const status = statusFor(participant);
          return (
            <div key={participant.userId} className="flex items-center gap-2 px-2.5 py-1">
              <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
                {participant.displayName.slice(0, 1).toUpperCase()}
                <span
                  aria-hidden
                  className={
                    status === 'online'
                      ? 'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-positive'
                      : 'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-ink-faint'
                  }
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-ink">
                  {participant.displayName}
                  {participant.isSelf && <span className="text-ink-faint"> (you)</span>}
                </span>
                <span className="block truncate font-mono text-sm text-ink-faint">
                  {participant.activePath ?? 'no file open'}
                </span>
              </span>
              <Badge tone={status === 'online' ? 'positive' : 'neutral'}>{status}</Badge>
            </div>
          );
        })}

        <p className="flex items-start gap-1.5 px-2.5 pb-2 pt-1 text-sm text-ink-faint">
          {transport === 'realtime' ? (
            <Wifi aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-positive" />
          ) : (
            <WifiOff aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          {transport === 'realtime'
            ? 'Live presence is connected.'
            : 'Live presence is not connected, so this shows only your own session — not who else may be working.'}
        </p>
      </section>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <p className="panel-label flex items-center gap-1.5 px-2.5 py-1.5">
          <History aria-hidden className="h-3 w-3" />
          Recent activity
        </p>

        {error ? (
          <div className="p-2.5">
            <ErrorState title="Could not load activity" detail={error} />
          </div>
        ) : loading && !events.length ? (
          <div className="flex items-center gap-2 p-2.5 text-sm text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Loading…
          </div>
        ) : !events.length ? (
          <EmptyState
            title="Nothing yet"
            description="Commits, branches, builds and assistant tasks show up here."
          />
        ) : (
          <ol>
            {events.map((event) => (
              <li key={event.id} className="border-b border-line/50 px-2.5 py-1.5 last:border-0">
                <p className="text-base text-ink">
                  <span className="text-ink-muted">{event.actorName}</span>{' '}
                  {describeActivity(event)}
                </p>
                <p className="text-sm text-ink-faint">{formatTimeAgo(event.createdAt)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
