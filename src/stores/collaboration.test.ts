import { beforeEach, describe, expect, it } from 'vitest';
import { useMemberStore } from '@/stores/memberStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { usePresenceStore, statusFor, IDLE_AFTER_MS } from '@/stores/presenceStore';
import { useFileStore } from '@/stores/fileStore';
import { useAuthStore } from '@/stores/authStore';
import { capabilitiesFor, atLeast } from '@/lib/permissions';
import type { AuthUser, MemberRole } from '@/types';

/**
 * Collaboration boundaries.
 *
 * The client checks here are not the security boundary — row level security is,
 * and `supabase/tests/rls.sql` covers it. What these hold in place is that the
 * client refuses the same things the database would, so a user gets an
 * explainable "no" instead of a raw policy error, and so a bug in a panel
 * cannot quietly hand somebody a capability their role does not carry.
 */

const USER: AuthUser = {
  id: 'user_self',
  email: 'self@test.dev',
  displayName: 'Self',
  avatarUrl: null,
  provider: 'local',
};

function signedInAs(role: MemberRole) {
  useAuthStore.setState({ user: USER, localMode: true });
  useFileStore.setState({ projectId: 'prj_1', role });
  useMemberStore.setState({ projectId: 'prj_1', members: [], loading: false, error: null });
}

beforeEach(() => {
  signedInAs('owner');
  useWorkspaceStore.setState({ workspaces: [], activeId: null, loading: false, error: null });
  usePresenceStore.getState().leave();
});

describe('who may change membership', () => {
  it('refuses every membership change to a viewer', async () => {
    signedInAs('viewer');
    await expect(useMemberStore.getState().invite('x@test.dev', 'editor')).rejects.toThrow(
      /admin access/i,
    );
    await expect(useMemberStore.getState().setRole('other', 'editor')).rejects.toThrow(
      /admin access/i,
    );
    await expect(useMemberStore.getState().remove('other')).rejects.toThrow(/admin access/i);
  });

  /** An editor can write code and still not decide who else may. */
  it('refuses membership changes to an editor', async () => {
    signedInAs('editor');
    await expect(useMemberStore.getState().invite('x@test.dev', 'viewer')).rejects.toThrow(
      /admin access/i,
    );
    expect(capabilitiesFor('editor').write).toBe(true);
    expect(capabilitiesFor('editor').manageMembers).toBe(false);
  });

  it('lets an admin manage members but not delete the project', () => {
    const admin = capabilitiesFor('admin');
    expect(admin.manageMembers).toBe(true);
    expect(admin.deleteProject).toBe(false);
    expect(capabilitiesFor('owner').deleteProject).toBe(true);
  });

  it('orders roles so a check is a comparison, not a list of special cases', () => {
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('editor', 'admin')).toBe(false);
    expect(atLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('protecting the owner', () => {
  beforeEach(() => {
    signedInAs('admin');
    useMemberStore.setState({
      projectId: 'prj_1',
      members: [
        {
          id: 'm1',
          projectId: 'prj_1',
          userId: 'user_owner',
          email: 'owner@test.dev',
          displayName: 'Owner',
          role: 'owner',
          addedAt: 0,
        },
      ],
      loading: false,
      error: null,
    });
  });

  it('refuses to demote the owner', async () => {
    await expect(useMemberStore.getState().setRole('user_owner', 'viewer')).rejects.toThrow(
      /owner/i,
    );
  });

  it('refuses to remove the owner', async () => {
    await expect(useMemberStore.getState().remove('user_owner')).rejects.toThrow(/owner/i);
  });

  it('refuses to let the owner leave their own project', async () => {
    signedInAs('owner');
    await expect(useMemberStore.getState().leave()).rejects.toThrow(/cannot leave/i);
  });
});

describe('inviting needs a real backend', () => {
  it('says so instead of pretending an invite was sent', async () => {
    signedInAs('owner');
    await expect(useMemberStore.getState().invite('x@test.dev', 'editor')).rejects.toThrow(
      /Supabase/,
    );
  });

  it('rejects an address that is obviously not one', async () => {
    signedInAs('owner');
    for (const bad of ['nope', 'a@b', '@test.dev', '']) {
      await expect(useMemberStore.getState().invite(bad, 'editor'), bad).rejects.toThrow(
        /email address/i,
      );
    }
  });
});

describe('workspaces group, they do not grant', () => {
  it('refuses a nameless workspace', async () => {
    await expect(useWorkspaceStore.getState().create({ name: '   ' })).rejects.toThrow(
      /cannot be empty/i,
    );
  });

  it('creates one owned by the signed-in account', async () => {
    const workspace = await useWorkspaceStore.getState().create({ name: 'Client work' });
    expect(workspace.ownerId).toBe(USER.id);
    expect(workspace.projectIds).toEqual([]);
    expect(useWorkspaceStore.getState().activeId).toBe(workspace.id);
  });

  it('adds and removes projects without duplicating them', async () => {
    const workspace = await useWorkspaceStore.getState().create({ name: 'W' });
    const store = useWorkspaceStore.getState();
    await store.addProject(workspace.id, 'prj_1');
    await store.addProject(workspace.id, 'prj_1');
    expect(useWorkspaceStore.getState().workspaces[0].projectIds).toEqual(['prj_1']);

    await useWorkspaceStore.getState().removeProject(workspace.id, 'prj_1');
    expect(useWorkspaceStore.getState().workspaces[0].projectIds).toEqual([]);
  });

  it('lists pinned workspaces before recent ones', async () => {
    const store = useWorkspaceStore.getState();
    const first = await store.create({ name: 'First' });
    const second = await store.create({ name: 'Second' });
    await useWorkspaceStore.getState().togglePin(first.id);

    const recent = useWorkspaceStore.getState().recent();
    expect(recent[0].id).toBe(first.id);
    expect(recent.map((w) => w.id)).toContain(second.id);
  });

  it('forgets the active workspace when it is deleted', async () => {
    const workspace = await useWorkspaceStore.getState().create({ name: 'Gone' });
    await useWorkspaceStore.getState().remove(workspace.id);
    expect(useWorkspaceStore.getState().activeId).toBeNull();
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });
});

describe('presence claims only what it knows', () => {
  it('reports no live transport, and only this session', () => {
    usePresenceStore.getState().enter('prj_1', USER);
    const state = usePresenceStore.getState();
    expect(state.transport).toBe('local-only');
    expect(state.participants()).toHaveLength(1);
    expect(state.participants()[0].isSelf).toBe(true);
  });

  it('tracks the file this session has open', () => {
    usePresenceStore.getState().enter('prj_1', USER);
    usePresenceStore.getState().touch('src/app.ts');
    expect(usePresenceStore.getState().self?.activePath).toBe('src/app.ts');
  });

  it('turns elapsed time into a status rather than assuming online', () => {
    const now = Date.now();
    const participant = {
      userId: 'u',
      displayName: 'U',
      email: 'u@test.dev',
      activePath: null,
      lastSeenAt: now,
      isSelf: false,
    };
    expect(statusFor(participant, now)).toBe('online');
    expect(statusFor(participant, now + IDLE_AFTER_MS + 1)).toBe('away');
    expect(statusFor(participant, now + IDLE_AFTER_MS * 6)).toBe('offline');
  });

  it('never lists a remote participant as this session', () => {
    usePresenceStore.getState().enter('prj_1', USER);
    usePresenceStore.getState().replaceRemote([
      {
        userId: 'other',
        displayName: 'Other',
        email: 'other@test.dev',
        activePath: null,
        lastSeenAt: Date.now(),
        isSelf: true,
      },
    ]);
    expect(usePresenceStore.getState().remote).toEqual([]);
  });
});
