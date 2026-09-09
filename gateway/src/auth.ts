import type { GatewayConfig } from './config.ts';
import { authError, permissionError } from './errors.ts';

/**
 * Who is asking, and what they may do — decided here and nowhere else.
 *
 * Two rules, and every other file depends on both:
 *
 *  1. The identity comes from a token Supabase verified. It is never decoded
 *     locally: a `sub` claim read out of an unverified JWT is a user id anybody
 *     can type, and a gateway that trusted one would hand any caller any
 *     workspace.
 *  2. The project role comes from the database, by the same rules the RLS
 *     policies use — owner, then membership. A `role` or `projectId` sent by
 *     the client is input to the lookup, never the answer to it.
 *
 * Reached over PostgREST with `fetch`, matching `supabase/functions/_shared`.
 * The service-role key never leaves the outbound headers of this file.
 */

export interface Identity {
  userId: string;
  email: string;
}

export type ProjectRole = 'viewer' | 'editor' | 'admin' | 'owner';

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function atLeast(role: ProjectRole | null, minimum: ProjectRole): boolean {
  return role !== null && RANK[role] >= RANK[minimum];
}

export interface Authorizer {
  /** Resolve a bearer token to a verified identity, or throw AUTH_ERROR. */
  identify(token: string): Promise<Identity>;
  /** The caller's role on a project, from the database. Null means no access. */
  roleOn(userId: string, projectId: string): Promise<ProjectRole | null>;
}

/** Bounded so a hung Supabase cannot pin a socket open indefinitely. */
const AUTH_TIMEOUT_MS = 10_000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createAuthorizer(config: GatewayConfig): Authorizer {
  const headers = {
    apikey: config.supabaseServiceKey,
    authorization: `Bearer ${config.supabaseServiceKey}`,
  };

  return {
    async identify(token) {
      if (!token) throw authError();

      let response: Response;
      try {
        response = await timedFetch(`${config.supabaseUrl}/auth/v1/user`, {
          headers: { authorization: `Bearer ${token}`, apikey: config.supabaseServiceKey },
        });
      } catch {
        // Told apart from a rejected token on purpose: "we could not check" is
        // a different operational fact from "you are not who you say".
        throw authError('Could not verify your session. Try again shortly.');
      }
      if (!response.ok) throw authError('Your session has expired. Sign in again.');

      const user = (await response.json().catch(() => null)) as
        | { id?: string; email?: string }
        | null;
      if (!user?.id) throw authError('Your session has expired. Sign in again.');
      return { userId: user.id, email: user.email ?? '' };
    },

    async roleOn(userId, projectId) {
      const project = await query<{ owner_id: string }>(
        `${config.supabaseUrl}/rest/v1/projects?select=owner_id&id=eq.${encodeURIComponent(projectId)}&limit=1`,
        headers,
      );
      if (!project.length) return null;
      if (project[0].owner_id === userId) return 'owner';

      const member = await query<{ role: string }>(
        `${config.supabaseUrl}/rest/v1/project_members` +
          `?select=role&project_id=eq.${encodeURIComponent(projectId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
        headers,
      );
      const role = member[0]?.role;
      return role === 'viewer' || role === 'editor' || role === 'admin' || role === 'owner'
        ? role
        : null;
    },
  };
}

async function query<T>(url: string, headers: Record<string, string>): Promise<T[]> {
  let response: Response;
  try {
    response = await timedFetch(url, { headers });
  } catch {
    throw permissionError('Could not check your access to this project. Try again shortly.');
  }
  if (!response.ok) {
    throw permissionError('Could not check your access to this project. Try again shortly.');
  }
  const rows = (await response.json().catch(() => null)) as T[] | null;
  return Array.isArray(rows) ? rows : [];
}

/**
 * The full check a terminal connection must pass.
 *
 * A container is a place where code runs against a project's files, so the bar
 * is `editor`: a viewer may read a project in the editor and must not get a
 * shell in it.
 */
export async function authorizeTerminal(
  authorizer: Authorizer,
  token: string,
  projectId: string,
): Promise<{ identity: Identity; role: ProjectRole }> {
  const identity = await authorizer.identify(token);
  const role = await authorizer.roleOn(identity.userId, projectId);
  if (!atLeast(role, 'editor')) {
    // Deliberately the same message whether the project is missing or merely
    // forbidden: telling a caller which one leaks whether an id exists.
    throw permissionError('You need edit access to this project to open a terminal.');
  }
  return { identity, role: role as ProjectRole };
}
