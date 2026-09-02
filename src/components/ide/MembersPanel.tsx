import { PanelHeader, Badge } from '@/components/ui/Primitives';
import { useFileStore } from '@/stores/fileStore';
import { useAuthStore } from '@/stores/authStore';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, capabilitiesFor } from '@/lib/permissions';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { MemberRole } from '@/types';

/**
 * Membership view.
 *
 * Inviting other people requires a Supabase project, because the invitation and
 * the permission it grants are both enforced by row level security. In Local
 * Development Mode there is exactly one account, and the panel says that rather
 * than showing an invite form that could not work.
 */
export function MembersPanel() {
  const role = useFileStore((s) => s.role);
  const meta = useFileStore((s) => s.meta);
  const user = useAuthStore((s) => s.user);
  const localMode = useAuthStore((s) => s.localMode);
  const capabilities = capabilitiesFor(role);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Members" />

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <section className="border-b border-line p-2.5">
          <p className="panel-label mb-2">This project</p>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
              {user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-ink">{user?.displayName ?? 'Unknown'}</p>
              <p className="truncate text-sm text-ink-faint">{user?.email}</p>
            </div>
            <Badge tone="accent">{ROLE_LABELS[role]}</Badge>
          </div>
          <p className="mt-2 text-sm text-ink-muted">{ROLE_DESCRIPTIONS[role]}</p>
        </section>

        <section className="border-b border-line p-2.5">
          <p className="panel-label mb-2">Your capabilities here</p>
          <ul className="space-y-1 text-sm">
            {(
              [
                ['Read files', capabilities.read],
                ['Edit files and commit', capabilities.write],
                ['Manage members', capabilities.manageMembers],
                ['Change project settings', capabilities.changeSettings],
                ['Delete the project', capabilities.deleteProject],
              ] as const
            ).map(([label, allowed]) => (
              <li key={label} className="flex items-center gap-2">
                <span className={allowed ? 'text-positive' : 'text-ink-faint'}>
                  {allowed ? '✓' : '✕'}
                </span>
                <span className={allowed ? 'text-ink' : 'text-ink-faint'}>{label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="p-2.5">
          <p className="panel-label mb-2">Roles</p>
          <dl className="space-y-2 text-sm">
            {(Object.keys(ROLE_LABELS) as MemberRole[]).map((item) => (
              <div key={item}>
                <dt className="text-ink">{ROLE_LABELS[item]}</dt>
                <dd className="text-ink-faint">{ROLE_DESCRIPTIONS[item]}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <p className="border-t border-line px-2.5 py-2 text-sm text-ink-faint">
        {localMode || !isSupabaseConfigured
          ? 'Sharing needs a Supabase project. In Local Development Mode this workspace has a single account, so there is no one to invite.'
          : `Invite members from the project settings. Every role is enforced by database policies on ${meta?.name ?? 'this project'}.`}
      </p>
    </div>
  );
}
