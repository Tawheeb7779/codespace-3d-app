import { useEffect, useState } from 'react';
import { LogOut, UserPlus, X } from 'lucide-react';
import { PanelHeader, Badge, Spinner, ErrorState } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Field';
import { useFileStore } from '@/stores/fileStore';
import { useAuthStore } from '@/stores/authStore';
import { useMemberStore } from '@/stores/memberStore';
import { useProjectStore } from '@/stores/projectStore';
import { toast } from '@/stores/toastStore';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, capabilitiesFor } from '@/lib/permissions';
import { isSupabaseConfigured } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';
import type { MemberRole, ProjectVisibility } from '@/types';

/**
 * Membership and sharing.
 *
 * Every control here is gated on the same `capabilitiesFor` the rest of the
 * app uses, and every action calls the store, which calls the repository,
 * which is checked again by row level security. Hiding a button is a courtesy,
 * not the boundary — a viewer who forces the call still gets refused, and the
 * refusal is what this panel reports.
 *
 * Inviting people needs a real backend. In Local Development Mode there is one
 * account, so the panel says that plainly instead of showing a form that could
 * not work.
 */

const ASSIGNABLE: MemberRole[] = ['admin', 'editor', 'viewer'];

const VISIBILITY_LABELS: Record<ProjectVisibility, string> = {
  private: 'Private — only members',
  team: 'Team — anyone on the team',
  public: 'Public — anyone signed in can read',
};

export function MembersPanel() {
  const role = useFileStore((s) => s.role);
  const meta = useFileStore((s) => s.meta);
  const projectId = useFileStore((s) => s.projectId);
  const user = useAuthStore((s) => s.user);
  const localMode = useAuthStore((s) => s.localMode);

  const members = useMemberStore((s) => s.members);
  const loading = useMemberStore((s) => s.loading);
  const error = useMemberStore((s) => s.error);
  const load = useMemberStore((s) => s.load);
  const invite = useMemberStore((s) => s.invite);
  const setRole = useMemberStore((s) => s.setRole);
  const removeMember = useMemberStore((s) => s.remove);
  const leave = useMemberStore((s) => s.leave);

  const capabilities = capabilitiesFor(role);
  const cloud = isSupabaseConfigured && !localMode;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('editor');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const guard = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast.error(label, errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const changeVisibility = (visibility: ProjectVisibility) => {
    if (!meta) return;
    void guard('Could not change visibility', async () => {
      await useProjectStore.getState().setVisibility(meta.id, visibility);
      toast.success('Visibility updated', VISIBILITY_LABELS[visibility]);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Members"
        actions={
          capabilities.manageMembers && (
            <IconButton
              label="Invite someone"
              icon={<UserPlus className="h-3.5 w-3.5" />}
              disabled={!cloud}
              onClick={() => setInviteOpen(true)}
            />
          )
        }
      />

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {/* Sharing */}
        <section className="border-b border-line p-2.5">
          <p className="panel-label mb-2">Who can see this project</p>
          <Select
            label="Visibility"
            value={meta?.visibility ?? 'private'}
            disabled={!capabilities.changeSettings}
            onChange={(event) => changeVisibility(event.target.value as ProjectVisibility)}
            options={(Object.keys(VISIBILITY_LABELS) as ProjectVisibility[]).map((value) => ({
              value,
              label: VISIBILITY_LABELS[value],
            }))}
            hint={
              capabilities.changeSettings
                ? 'Public grants reading only. Editing always needs a role on the project.'
                : 'Only an admin or the owner can change this.'
            }
          />
        </section>

        {/* People */}
        <section className="border-b border-line">
          <p className="panel-label px-2.5 py-1.5">People</p>

          {error ? (
            <div className="p-2.5">
              <ErrorState title="Could not load members" detail={error} />
            </div>
          ) : loading && !members.length ? (
            <div className="flex items-center gap-2 p-2.5 text-sm text-ink-faint">
              <Spinner className="h-3.5 w-3.5" /> Loading…
            </div>
          ) : (
            <>
              {/* The signed-in account always appears, membership row or not. */}
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
                  {user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">
                    {user?.displayName ?? 'Unknown'} <span className="text-ink-faint">(you)</span>
                  </p>
                  <p className="truncate text-sm text-ink-faint">{user?.email}</p>
                </div>
                <Badge tone="accent">{ROLE_LABELS[role]}</Badge>
              </div>

              {members
                .filter((member) => member.userId !== user?.id)
                .map((member) => (
                  <div key={member.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised text-xs font-medium text-ink-muted">
                      {member.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-ink">{member.displayName}</p>
                      <p className="truncate text-sm text-ink-faint">{member.email}</p>
                    </div>
                    {capabilities.manageMembers && member.role !== 'owner' ? (
                      <>
                        <Select
                          aria-label={`Role for ${member.displayName}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void guard('Could not change role', () =>
                              setRole(member.userId, event.target.value as MemberRole),
                            )
                          }
                          options={ASSIGNABLE.map((value) => ({
                            value,
                            label: ROLE_LABELS[value],
                          }))}
                        />
                        <IconButton
                          label={`Remove ${member.displayName}`}
                          icon={<X className="h-3.5 w-3.5" />}
                          disabled={busy}
                          onClick={() =>
                            void guard('Could not remove member', () => removeMember(member.userId))
                          }
                        />
                      </>
                    ) : (
                      <Badge>{ROLE_LABELS[member.role]}</Badge>
                    )}
                  </div>
                ))}
            </>
          )}

          {!cloud && (
            <p className="px-2.5 pb-2 text-sm text-ink-faint">
              Sharing needs a Supabase project. Local Development Mode has a single account, so
              there is nobody to invite.
            </p>
          )}
        </section>

        {/* Capabilities */}
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
          <p className="mt-2 text-sm text-ink-muted">{ROLE_DESCRIPTIONS[role]}</p>
        </section>

        {role !== 'owner' && (
          <section className="p-2.5">
            <Button
              size="xs"
              leading={<LogOut className="h-3 w-3" />}
              disabled={busy}
              onClick={() =>
                void guard('Could not leave', async () => {
                  await leave();
                  toast.success('You left this project');
                })
              }
            >
              Leave this project
            </Button>
          </section>
        )}
      </div>

      <p className="border-t border-line px-2.5 py-2 text-sm text-ink-faint">
        Every role is enforced by database policies, not by this panel.
      </p>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite to this project"
        description="They receive the role you choose. Roles are enforced by the database."
        size="sm"
        footer={
          <>
            <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void guard('Could not invite', async () => {
                  await invite(email, inviteRole);
                  toast.success('Invited', email);
                  setEmail('');
                  setInviteOpen(false);
                })
              }
            >
              Send invite
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Email address"
            autoFocus
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="colleague@example.com"
          />
          <Select
            label="Role"
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as MemberRole)}
            options={ASSIGNABLE.map((value) => ({ value, label: ROLE_LABELS[value] }))}
            hint={ROLE_DESCRIPTIONS[inviteRole]}
          />
        </div>
      </Modal>
    </div>
  );
}
