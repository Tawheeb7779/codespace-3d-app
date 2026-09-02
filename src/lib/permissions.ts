import type { MemberRole } from '@/types';

/**
 * Client-side permission helpers.
 *
 * These exist to render the right affordances — they are **not** the security
 * boundary. Every mutation is also checked by Postgres row level security in
 * `supabase/migrations`, which is what actually stops a user from writing to a
 * project they only have read access to.
 */

export const ROLE_ORDER: MemberRole[] = ['viewer', 'editor', 'admin', 'owner'];

export function roleRank(role: MemberRole): number {
  return ROLE_ORDER.indexOf(role);
}

export function atLeast(role: MemberRole, minimum: MemberRole): boolean {
  return roleRank(role) >= roleRank(minimum);
}

export interface Capabilities {
  read: boolean;
  write: boolean;
  manageMembers: boolean;
  deleteProject: boolean;
  changeSettings: boolean;
}

export function capabilitiesFor(role: MemberRole): Capabilities {
  return {
    read: true,
    write: atLeast(role, 'editor'),
    manageMembers: atLeast(role, 'admin'),
    changeSettings: atLeast(role, 'admin'),
    deleteProject: role === 'owner',
  };
}

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: 'Full control, including deleting the project and transferring ownership.',
  admin: 'Can edit files and manage members, but cannot delete the project.',
  editor: 'Can read and write files, run builds and commit.',
  viewer: 'Read-only access. Cannot modify files or run write tools.',
};
