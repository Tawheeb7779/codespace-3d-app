import { readdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { containerIdFor } from './lifecycle.ts';
import { workspaceDirFor } from './workspace.ts';

/**
 * Workspaces left behind when the container id changed.
 *
 * The id names the workspace directory, and it changed from a 32-bit FNV-1a to
 * a 128-bit SHA-256 because the old one could be collided on purpose: project
 * ids are chosen in the browser, so an attacker ground out a project id whose
 * key hashed to a victim's and mounted their workspace. Fixing that renamed
 * every future workspace and stranded every existing one.
 *
 * **Why this does not migrate automatically, which is the whole design.**
 *
 * Automatic migration needs to answer "who owns this directory", and nothing
 * can answer it:
 *
 *   * The directory name is a one-way hash. Given `tacode-10847e1b` there is no
 *     way to recover the `(user, project)` that produced it.
 *   * `container_workspaces` would be the record that ties an id to a user, and
 *     the gateway has never written a row to it. The table exists, it has
 *     policies, and it is empty.
 *   * The old hash *collided by construction* — that was the vulnerability. So
 *     a legacy directory does not necessarily correspond to one pair at all.
 *
 * Migrating on a guess would mean handing one user a directory that may be
 * another's, which is precisely the exposure the id change closed. Doing it
 * silently, at container start, would make that exposure automatic.
 *
 * So this module detects and reports, and moves a directory only when a human
 * names the pair it belongs to. That is slower and it is the only version that
 * cannot lose or leak somebody's work. Nothing here deletes anything, ever.
 */

/** `tacode-` followed by exactly eight hex characters: the old format. */
const LEGACY_ID = /^tacode-[0-9a-f]{8}$/;
/** `tacode-` followed by exactly thirty-two: the current one. */
const CURRENT_ID = /^tacode-[0-9a-f]{32}$/;

export function isLegacyWorkspaceId(name: string): boolean {
  return LEGACY_ID.test(name);
}

export function isCurrentWorkspaceId(name: string): boolean {
  return CURRENT_ID.test(name);
}

/**
 * The id a `(user, project)` pair had under the old hash.
 *
 * Kept verbatim rather than approximated, because it is the only way to find
 * the directory a known pair used to own. It is never used to *create* a
 * workspace — `containerIdFor` does that — and the two are deliberately
 * separate so this cannot be mistaken for a live code path.
 */
export function legacyContainerIdFor(userId: string, projectId: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${userId}:${projectId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `tacode-${hash.toString(16).padStart(8, '0')}`;
}

export interface WorkspaceCensus {
  legacy: string[];
  current: string[];
  /** Anything that is neither. Reported, never touched. */
  unknown: string[];
}

/**
 * What is actually in the workspace root.
 *
 * Directories only: a file sitting in the root is somebody else's business and
 * is reported as unknown rather than assumed to be a stray workspace.
 */
export async function censusWorkspaces(workspaceRoot: string): Promise<WorkspaceCensus> {
  const census: WorkspaceCensus = { legacy: [], current: [], unknown: [] };
  const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, so a link planted in the root is
    // never classified as a workspace and never migrated.
    if (!entry.isDirectory()) {
      census.unknown.push(entry.name);
      continue;
    }
    if (isLegacyWorkspaceId(entry.name)) census.legacy.push(entry.name);
    else if (isCurrentWorkspaceId(entry.name)) census.current.push(entry.name);
    else census.unknown.push(entry.name);
  }

  census.legacy.sort();
  census.current.sort();
  census.unknown.sort();
  return census;
}

export type MigrationOutcome =
  | { status: 'migrated'; from: string; to: string }
  | { status: 'already-migrated'; from: string; to: string }
  | { status: 'nothing-to-do'; from: string; to: string }
  | { status: 'refused'; from: string; to: string; reason: string };

/**
 * Move one legacy workspace to the name its pair uses now.
 *
 * The caller must name the `(user, project)` pair, and that is the point: the
 * pair is the ownership claim, and a person makes it. Both ids are derived
 * here rather than accepted as arguments, so a caller cannot ask for an
 * arbitrary directory to be moved to an arbitrary place.
 *
 * Every refusal below is a case where continuing could destroy or merge
 * somebody's work:
 *
 *   * A target that already exists and has content is a workspace in use. A
 *     rename over it would either fail or merge two projects' files, and both
 *     are worse than stopping.
 *   * A source that is not a legacy id at all means the caller has the wrong
 *     directory.
 *
 * Idempotent: run it twice and the second run reports `already-migrated`,
 * because the source is gone and the target is there.
 */
export async function migrateWorkspace(
  workspaceRoot: string,
  userId: string,
  projectId: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationOutcome> {
  const legacyId = legacyContainerIdFor(userId, projectId);
  const currentId = containerIdFor(userId, projectId);

  // Through the same validator live code uses, so a crafted id cannot escape
  // the root even here.
  const from = workspaceDirFor(workspaceRoot, legacyId);
  const to = workspaceDirFor(workspaceRoot, currentId);

  const source = await stat(from).catch(() => null);
  const target = await stat(to).catch(() => null);

  if (!source) {
    return target
      ? { status: 'already-migrated', from: legacyId, to: currentId }
      : { status: 'nothing-to-do', from: legacyId, to: currentId };
  }
  if (!source.isDirectory()) {
    return {
      status: 'refused',
      from: legacyId,
      to: currentId,
      reason: 'the legacy path is not a directory',
    };
  }

  if (target) {
    // A target that exists but is empty is the ordinary case of a container
    // having been started once since the id changed; moving into it is safe.
    // A target with anything in it is a workspace somebody is using.
    const contents = await readdir(to).catch(() => null);
    if (contents === null || contents.length > 0) {
      return {
        status: 'refused',
        from: legacyId,
        to: currentId,
        reason:
          'a workspace already exists under the new id and is not empty; ' +
          'migrating would merge two workspaces',
      };
    }
  }

  if (options.dryRun) {
    return { status: 'migrated', from: legacyId, to: currentId };
  }

  // `rename` rather than a copy: it is atomic within a filesystem, so there is
  // no window where the files exist in neither place or in both. It fails
  // rather than merging if the target is a non-empty directory, which is the
  // same refusal as above enforced by the kernel.
  await rename(from, resolve(to));
  return { status: 'migrated', from: legacyId, to: currentId };
}

/**
 * A one-line summary for an operator, or null when there is nothing to say.
 *
 * Deliberately not an error and not a failure to start. Legacy workspaces are
 * files somebody may still want, and a gateway that refused to run because of
 * them would be a gateway an operator deletes them to get rid of.
 */
export function censusWarning(census: WorkspaceCensus): string | null {
  if (!census.legacy.length) return null;
  return (
    `${census.legacy.length} workspace director${census.legacy.length === 1 ? 'y uses' : 'ies use'} ` +
    'the pre-SHA-256 container id and will not be found by any user. ' +
    'They are untouched. See "workspace migration" in gateway/README.md; ' +
    'ownership cannot be established automatically, so migration is per project.'
  );
}

/** Every legacy directory, paired with the absolute path, for a report. */
export function legacyPaths(workspaceRoot: string, census: WorkspaceCensus): string[] {
  return census.legacy.map((name) => join(workspaceRoot, name));
}
