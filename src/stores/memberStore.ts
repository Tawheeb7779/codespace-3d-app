import { create } from 'zustand';
import type { MemberRole, ProjectMember } from '@/types';
import { repositoryFor } from '@/lib/repo';
import { useAuthStore } from '@/stores/authStore';
import { useFileStore } from '@/stores/fileStore';
import { capabilitiesFor } from '@/lib/permissions';
import { recordActivity } from '@/stores/activityStore';
import {
  createInvitationToken,
  hashInvitationToken,
  invitationLink,
  isRedeemable,
  type PendingInvitation,
} from '@/lib/invitations';
import { errorMessage } from '@/lib/utils';

/**
 * Project membership.
 *
 * The checks in this file decide what the UI offers. They are not the security
 * boundary: the same rules live in row level security, and a request the
 * database rejects fails here too, loudly. Checking twice is deliberate — the
 * client check gives an immediate, explainable refusal, and the database check
 * is the one that cannot be bypassed.
 */

interface MemberState {
  projectId: string | null;
  members: ProjectMember[];
  loading: boolean;
  error: string | null;

  invitations: PendingInvitation[];

  load: (projectId: string) => Promise<void>;
  /**
   * Create an invitation and return the one-time link.
   *
   * The link is returned rather than stored because only its hash reaches the
   * database — there is no way to show it again later, which is the point.
   */
  invite: (email: string, role: MemberRole) => Promise<string>;
  revokeInvitation: (id: string) => Promise<void>;
  setRole: (userId: string, role: MemberRole) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  leave: () => Promise<void>;
  clear: () => void;
}

function repository() {
  return repositoryFor(useAuthStore.getState().user?.provider);
}

/** Only a project admin or owner may change who is on it. */
function assertCanManage(): void {
  if (!capabilitiesFor(useFileStore.getState().role).manageMembers) {
    throw new Error('You need admin access on this project to manage members.');
  }
}

export function validateEmail(email: string): string {
  const clean = email.trim().toLowerCase();
  // Deliberately permissive: the authoritative check is the invitation itself
  // reaching a real account. This only catches obvious typing mistakes.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('That does not look like an email address.');
  }
  return clean;
}

export const useMemberStore = create<MemberState>()((set, get) => ({
  projectId: null,
  members: [],
  invitations: [],
  loading: false,
  error: null,

  async load(projectId) {
    set({ projectId, loading: true, error: null });
    try {
      const members = await repository().listMembers(projectId);
      // Invitations are only visible to an administrator; for everyone else
      // the policy returns nothing, which is the correct empty list.
      const invitations = await repository()
        .listInvitations(projectId)
        .catch(() => [] as PendingInvitation[]);
      // A slow answer for a project the user has since left must not land.
      if (get().projectId !== projectId) return;
      set({ members, invitations, loading: false });
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  /**
   * Invite somebody, by creating a pending record they redeem.
   *
   * Not a membership row: the invitee may not have an account yet, and
   * `project_members.user_id` references one. The returned link carries the
   * only copy of the raw token.
   */
  async invite(email, role) {
    assertCanManage();
    const projectId = get().projectId;
    if (!projectId) throw new Error('Open a project first.');
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('You must be signed in to invite anyone.');
    const clean = validateEmail(email);

    if (get().members.some((member) => member.email === clean)) {
      throw new Error('That person is already a member of this project.');
    }
    if (
      get().invitations.some(
        (invitation) => invitation.email === clean && isRedeemable(invitation),
      )
    ) {
      throw new Error('That person already has an invitation waiting.');
    }

    // Generated here, hashed here; only the hash is sent. The raw token
    // exists in the returned link and nowhere else, ever.
    const token = createInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const invitation = await repository().createInvitation({
      projectId,
      tokenHash,
      email: clean,
      role,
      invitedBy: user.id,
    });

    set((state) => ({ invitations: [invitation, ...state.invitations] }));
    recordActivity('member.added', `invited ${clean}`);
    return invitationLink(window.location.origin, token);
  },

  async revokeInvitation(id) {
    assertCanManage();
    await repository().revokeInvitation(id);
    set((state) => ({
      invitations: state.invitations.map((invitation) =>
        invitation.id === id ? { ...invitation, revokedAt: Date.now() } : invitation,
      ),
    }));
  },

  async setRole(userId, role) {
    assertCanManage();
    const projectId = get().projectId;
    if (!projectId) throw new Error('Open a project first.');
    const target = get().members.find((member) => member.userId === userId);
    if (!target) throw new Error('That person is not a member of this project.');
    if (target.role === 'owner') {
      throw new Error('The owner’s role cannot be changed here.');
    }

    const before = get().members;
    set({ members: before.map((m) => (m.userId === userId ? { ...m, role } : m)) });
    try {
      await repository().setMemberRole(projectId, userId, role);
      recordActivity('member.role', `${target.email} → ${role}`);
    } catch (error) {
      set({ members: before });
      throw error;
    }
  },

  async remove(userId) {
    assertCanManage();
    const projectId = get().projectId;
    if (!projectId) throw new Error('Open a project first.');
    const target = get().members.find((member) => member.userId === userId);
    if (target?.role === 'owner') {
      throw new Error('The owner cannot be removed. Transfer ownership first.');
    }

    await repository().removeMember(projectId, userId);
    set((state) => ({ members: state.members.filter((member) => member.userId !== userId) }));
    recordActivity('member.removed', target?.email ?? userId);
  },

  /** Leaving is the one membership change that needs no admin rights. */
  async leave() {
    const projectId = get().projectId;
    const user = useAuthStore.getState().user;
    if (!projectId || !user) throw new Error('Open a project first.');
    if (useFileStore.getState().role === 'owner') {
      throw new Error('The owner cannot leave their own project. Transfer ownership or delete it.');
    }
    await repository().removeMember(projectId, user.id);
    set((state) => ({ members: state.members.filter((member) => member.userId !== user.id) }));
  },

  clear: () => set({ projectId: null, members: [], invitations: [], error: null }),
}));
