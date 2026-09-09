import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSensitivePath, resolveInWorkspaceNoSymlinks } from './workspace.ts';
import type { ContainerRecord } from './lifecycle.ts';
import { GatewayError } from './errors.ts';

/**
 * Moving files between a project and a Linux workspace, on purpose.
 *
 * The two workspaces are deliberately unconnected: a Linux workspace mounts no
 * project, and a project's container mounts nothing else. This is the only path
 * between them, and its shape follows from that — a person names files and a
 * direction, and each file crosses or is refused with a reason.
 *
 * What this is not, and each absence is a decision:
 *
 *   * Not a mount. Nothing here makes one workspace visible inside another;
 *     bytes are copied and the two trees stay independent.
 *   * Not recursive by default over a whole tree. A caller names paths, bounded
 *     in count and in size, so "copy my project into Linux" is a list somebody
 *     built rather than a button that walks everything.
 *   * Not an overwrite. A destination that already exists is reported as a
 *     conflict, because two independent workspaces give the gateway no basis
 *     for deciding which copy was wanted.
 *
 * Both endpoints are authorised by the caller before this is reached — see
 * `onTransfer` in the server, which resolves each container by id *and* owner.
 * This module assumes ownership is settled and enforces everything else.
 */

/** Bytes of a single file. Larger than the sync limit: this is explicit and rare. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Total bytes one transfer may move, so a hundred large files is still bounded. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface TransferOutcome {
  copied: string[];
  conflicts: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Copy named files from one workspace to another.
 *
 * Every path is resolved on both sides with the symlink-refusing resolver, so
 * neither a source link pointing at `/etc` nor a destination link pointing out
 * of the workspace can be used to read or write outside either tree. That is
 * the same resolver the sync engine uses, and using it here rather than a
 * second implementation is the point.
 */
export async function transferFiles(
  from: ContainerRecord,
  to: ContainerRecord,
  paths: string[],
  options: { overwrite?: boolean } = {},
): Promise<TransferOutcome> {
  if (from.id === to.id) {
    throw new GatewayError('SYNC_ERROR', 'A workspace cannot copy files to itself.');
  }
  if (from.userId !== to.userId) {
    // Unreachable through the server, which resolves both by owner, and
    // asserted anyway: this function is the one that touches two trees at once,
    // and a future caller that forgets is the failure worth refusing here.
    throw new GatewayError('PERMISSION_ERROR', 'Those workspaces belong to different people.');
  }

  const outcome: TransferOutcome = { copied: [], conflicts: [], skipped: [] };
  let budget = MAX_TOTAL_BYTES;

  for (const path of paths) {
    // Protected on either side. `.env`, `.ssh`, `.npmrc`, `.aws`, `.git` and
    // the dependency directories never cross: a transfer is exactly how a
    // credential file would be carried out of a project, and how a `.git` would
    // arrive somewhere it would confuse both repositories.
    if (isSensitivePath(path)) {
      outcome.skipped.push({ path, reason: 'protected path' });
      continue;
    }

    const source = await resolveInWorkspaceNoSymlinks(from.workspaceDir, path).catch(() => null);
    if (source === null) {
      outcome.skipped.push({ path, reason: 'path is not valid in the source workspace' });
      continue;
    }

    const info = await stat(source).catch(() => null);
    if (!info || !info.isFile()) {
      outcome.skipped.push({ path, reason: 'not a file' });
      continue;
    }
    if (info.size > MAX_FILE_BYTES) {
      outcome.skipped.push({ path, reason: 'file exceeds the transfer size limit' });
      continue;
    }
    if (info.size > budget) {
      outcome.skipped.push({ path, reason: 'transfer exceeds the total size limit' });
      continue;
    }

    const target = await resolveInWorkspaceNoSymlinks(to.workspaceDir, path).catch(() => null);
    if (target === null) {
      outcome.skipped.push({ path, reason: 'path is not valid in the destination workspace' });
      continue;
    }

    const existing = await stat(target).catch(() => null);
    if (existing && !options.overwrite) {
      outcome.conflicts.push(path);
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    budget -= info.size;
    outcome.copied.push(path);
  }

  return outcome;
}
