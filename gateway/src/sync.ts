import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSensitivePath, resolveInWorkspace, shouldSync } from './workspace.ts';
import { GatewayError } from './errors.ts';

/**
 * Keeping the editor and the container's filesystem in agreement.
 *
 * Two writers, no lock, and a network in between, so the design is about what
 * happens when they disagree rather than about copying bytes.
 *
 * **Content hashes, not timestamps.** A timestamp answers "which happened
 * later", which is the wrong question and often unanswerable: `npm install`
 * rewrites thousands of mtimes, a container clock is not the browser's, and a
 * file written twice with identical content is not a change at all. A hash
 * answers "is this the same file", which is the question, and it is the same
 * answer on both sides.
 *
 * **Loops are broken by the hash, not by a timer.** The obvious failure is
 * editor → container → watcher → editor → container, forever. Suppression
 * windows are the usual fix and they are wrong: too short and the loop runs,
 * too long and a real edit made a moment later is swallowed. Here every write
 * records the hash it produced, and a watcher event whose hash matches what we
 * last wrote is not an event — it is the echo of our own write, and it stops
 * there. Correct regardless of timing, and it cannot swallow a genuine change,
 * because a genuine change has a different hash.
 *
 * **Conflicts are detected, never resolved silently.** Each side reports the
 * hash it believes the file had. If neither matches what is on disk, both sides
 * changed it, and no amount of ordering makes one of them right. The write is
 * refused and the conflict is reported, because losing an hour of somebody's
 * work quietly is the worst thing this file could do.
 */

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/** Where a change came from. Decides who may overwrite whom. */
export type Origin = 'editor' | 'container';

export interface FileState {
  path: string;
  hash: string;
  size: number;
  /** The hash of the last write *we* performed, whichever side it came from. */
  writtenHash: string;
  writtenBy: Origin;
  updatedAt: number;
}

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

export type SyncOutcome =
  | { status: 'written'; path: string; hash: string }
  | { status: 'unchanged'; path: string; hash: string }
  | { status: 'skipped'; path: string; reason: string }
  | { status: 'conflict'; path: string; containerHash: string; editorHash: string };

export interface SyncLimits {
  maxFileBytes: number;
  maxFiles: number;
}

/**
 * The state both directions consult.
 *
 * Deliberately in memory. It describes a live container, and a container that
 * has gone away has no state worth having survived it — persisting this would
 * mean recovering a synchronisation position for a filesystem that no longer
 * exists, which is worse than starting from a fresh manifest.
 */
export class SyncIndex {
  private readonly files = new Map<string, FileState>();

  get size(): number {
    return this.files.size;
  }

  get(path: string): FileState | undefined {
    return this.files.get(path);
  }

  record(path: string, hash: string, size: number, by: Origin): void {
    this.files.set(path, {
      path,
      hash,
      size,
      writtenHash: hash,
      writtenBy: by,
      updatedAt: Date.now(),
    });
  }

  forget(path: string): void {
    this.files.delete(path);
  }

  /**
   * Whether a filesystem event is the echo of a write we just made.
   *
   * The whole loop-prevention story, in one comparison.
   */
  isEcho(path: string, hash: string): boolean {
    return this.files.get(path)?.writtenHash === hash;
  }

  manifest(): ManifestEntry[] {
    return [...this.files.values()]
      .map(({ path, hash, size }) => ({ path, hash, size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

/**
 * Write an editor-originated change into the workspace.
 *
 * `baseHash` is what the editor believed the file contained. If the file on
 * disk is something else, the container changed it too, and this refuses
 * instead of choosing.
 */
export async function applyEditorWrite(
  workspaceDir: string,
  index: SyncIndex,
  file: { path: string; content: string; baseHash?: string },
  limits: SyncLimits,
): Promise<SyncOutcome> {
  const { path, content } = file;

  if (isSensitivePath(path)) {
    return { status: 'skipped', path, reason: 'protected path' };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxFileBytes) {
    return { status: 'skipped', path, reason: 'file exceeds the size limit' };
  }

  const target = resolveInWorkspace(workspaceDir, path);
  const nextHash = hashContent(content);

  const onDisk = await readIfPresent(target);
  const currentHash = onDisk === null ? null : hashContent(onDisk);

  if (currentHash === nextHash) {
    index.record(path, nextHash, bytes, 'editor');
    return { status: 'unchanged', path, hash: nextHash };
  }

  // The file changed under us since the editor last saw it, and the editor is
  // not writing that same content — genuinely concurrent, so refuse.
  //
  // A missing `baseHash` is treated the same way when the file exists, and
  // that is the stricter reading on purpose: the editor omits it only for a
  // file the plan said the container did not have, so a file that is there
  // anyway appeared between the plan and this write. Rare, and precisely the
  // race where "no base" would otherwise mean "overwrite whatever is there".
  if (currentHash !== null && currentHash !== file.baseHash) {
    return { status: 'conflict', path, containerHash: currentHash, editorHash: nextHash };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  index.record(path, nextHash, bytes, 'editor');
  return { status: 'written', path, hash: nextHash };
}

/**
 * Read a container-originated change for the editor.
 *
 * Returns null when there is nothing for the editor to do: a path it must never
 * hold, a file too large to send, or — the common case, thousands of times a
 * second during a build — the echo of a write the editor itself just made.
 */
export async function readContainerChange(
  workspaceDir: string,
  index: SyncIndex,
  path: string,
  limits: SyncLimits,
): Promise<{ path: string; content: string; hash: string } | null> {
  if (!shouldSync(path)) return null;

  const target = resolveInWorkspace(workspaceDir, path);
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) return null;
  if (info.size > limits.maxFileBytes) return null;

  const raw = await readFile(target).catch(() => null);
  if (raw === null) return null;
  // Binary files have no representation in the editor's text VFS. Detected by
  // content rather than extension, because a build tool's output is whatever it
  // decided to write.
  if (raw.includes(0)) return null;

  const hash = hashContent(raw);
  if (index.isEcho(path, hash)) return null;

  const content = raw.toString('utf8');
  index.record(path, hash, info.size, 'container');
  return { path, content, hash };
}

export async function applyEditorDelete(
  workspaceDir: string,
  index: SyncIndex,
  path: string,
): Promise<SyncOutcome> {
  if (isSensitivePath(path)) return { status: 'skipped', path, reason: 'protected path' };
  const target = resolveInWorkspace(workspaceDir, path);
  await rm(target, { force: true });
  index.forget(path);
  return { status: 'written', path, hash: '' };
}

/**
 * The initial push, as a plan rather than a transfer.
 *
 * The editor sends a manifest of paths and hashes; this answers with the subset
 * the container does not already have. A reconnect after a dropped sync then
 * costs the files that are actually missing rather than the project, which is
 * the difference between a usable feature and one nobody waits for on a
 * ten-thousand-file repository.
 */
export function planInitialSync(
  editorManifest: ManifestEntry[],
  containerManifest: ManifestEntry[],
  limits: SyncLimits,
): {
  needed: string[];
  diverged: Array<{ path: string; containerHash: string }>;
  skipped: Array<{ path: string; reason: string }>;
  stale: string[];
} {
  if (editorManifest.length > limits.maxFiles) {
    throw new GatewayError(
      'SYNC_ERROR',
      'This project has more files than a workspace can hold.',
      `manifest of ${editorManifest.length} exceeds ${limits.maxFiles}`,
    );
  }

  const container = new Map(containerManifest.map((entry) => [entry.path, entry.hash]));
  const needed: string[] = [];
  const diverged: Array<{ path: string; containerHash: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const entry of editorManifest) {
    if (isSensitivePath(entry.path)) {
      skipped.push({ path: entry.path, reason: 'protected path' });
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      skipped.push({ path: entry.path, reason: 'file exceeds the size limit' });
      continue;
    }

    const present = container.get(entry.path);
    if (present === entry.hash) continue;

    // Absent from the container, so sending it can overwrite nothing.
    if (present === undefined) {
      needed.push(entry.path);
      continue;
    }

    // Present, and different. Both sides have content and neither is derived
    // from the other — a `git checkout` in the terminal, or a container that
    // outlived the tab that filled it. Pushing over it is a silent data loss,
    // and it is the loss nobody notices until the file is needed, so this is
    // reported as a conflict exactly like a concurrent write.
    diverged.push({ path: entry.path, containerHash: present });
  }

  // Present in the container, gone from the editor. Reported rather than
  // deleted: a container's extra files are usually build output, and deleting
  // whatever the editor has not heard of is how a sync destroys a `dist`
  // somebody was serving.
  const editorPaths = new Set(editorManifest.map((entry) => entry.path));
  const stale = containerManifest
    .filter((entry) => !editorPaths.has(entry.path) && shouldSync(entry.path))
    .map((entry) => entry.path);

  return { needed, diverged, skipped, stale };
}

/**
 * What the container's filesystem actually holds, as a manifest.
 *
 * Read from disk rather than from {@link SyncIndex}, and the difference
 * matters: the index knows what *this gateway* wrote or read, which after a
 * restart, a `git checkout` or a build is a strict and unhelpful subset of what
 * is there. A plan built from the index would ask the editor to resend files
 * the container already has, which on a large project is the whole project.
 *
 * Bounded by `maxFiles`, and it reads every file it lists — so it is called
 * once, when a panel opens or after a storm, and never on the hot path.
 */
export async function containerManifest(
  workspaceDir: string,
  paths: string[],
  limits: SyncLimits,
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const path of paths.slice(0, limits.maxFiles)) {
    const target = resolveInWorkspace(workspaceDir, path);
    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) continue;
    // Hashing a 200MB artefact to decide it will never be synced is work with
    // no possible consumer.
    if (info.size > limits.maxFileBytes) continue;
    const raw = await readFile(target).catch(() => null);
    if (raw === null) continue;
    entries.push({ path, hash: hashContent(raw), size: info.size });
  }
  return entries;
}

async function readIfPresent(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}
