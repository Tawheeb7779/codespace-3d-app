import { LIMITS, type ManifestEntryFrame } from '@/lib/terminal/protocol';
import type { ContainerTerminal } from '@/lib/terminal/containerClient';
import { isSensitivePath, normalizePath } from '@/lib/vfs';

/**
 * The editor's filesystem and the container's, kept in agreement.
 *
 * The gateway half of this lives in `gateway/src/sync.ts` and decides what a
 * change *means* — echo, conflict, or write. This half decides what the editor
 * does about it, and it exists because the two sides have different problems.
 * The gateway's problem is a build writing ninety thousand files. The editor's
 * problem is a person typing.
 *
 * So the rules here are about the person:
 *
 * **Debounced, never per-keystroke.** A write to the store is not a reason to
 * touch the network. Changes accumulate and go out as one batch, which is also
 * what makes the conflict check meaningful — a base hash per keystroke would be
 * a conflict check against a file nobody else could have touched yet.
 *
 * **Applied, never replaced.** A container change reaches Monaco as an edit
 * operation over the smallest changed range, so undo still works and the cursor
 * stays where the person left it. Replacing the model's value is the obvious
 * implementation and it silently throws away their undo history.
 *
 * **Loops broken by content, not by timing.** Every write we apply from the
 * container is remembered by hash; a store change matching that hash is our own
 * echo and is not sent back. This mirrors `SyncIndex.isEcho` exactly, and for
 * the same reason: a suppression window is either too short to stop the loop or
 * long enough to swallow a real edit.
 */

/** The gateway's hash function, in the browser. Must agree byte for byte. */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

export interface Conflict {
  path: string;
  containerHash: string;
  editorHash: string;
}

export interface WorkspaceSyncOptions {
  terminal: Pick<
    ContainerTerminal,
    'sendManifest' | 'pushFiles' | 'deleteFiles' | 'containerId'
  >;
  /** The editor's current tree, read fresh each time rather than mirrored. */
  files: () => Record<string, string>;
  /** Apply the container's changes to the editor. */
  applyFromContainer: (
    files: Array<{ path: string; content: string }>,
    deleted: string[],
  ) => void;
  /**
   * A file both sides changed.
   *
   * Surfaced, never resolved here. Losing an hour of somebody's work quietly is
   * the worst thing this module could do, so the decision goes to the person
   * whose work it is.
   */
  onConflict: (conflict: Conflict) => void;
  /** Paths the gateway will never accept, so the editor can say so once. */
  onSkipped?: (skipped: Array<{ path: string; reason: string }>) => void;
  debounceMs?: number;
}

const DEBOUNCE_MS = 300;

export class WorkspaceSync {
  /** Hash of the last content we know both sides agreed on, per path. */
  private readonly base = new Map<string, string>();
  /** Hashes we applied *from* the container, so we do not send them back. */
  private readonly applied = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly options: WorkspaceSyncOptions) {}

  /**
   * Offer the whole tree and wait to be told what is missing.
   *
   * Called once the container reports ready, and again after a storm. Sending
   * a manifest rather than the files is what keeps reopening a large project
   * cheap: the answer is usually a handful of paths.
   */
  async start(): Promise<void> {
    this.started = true;
    const files = this.options.files();
    const manifest: ManifestEntryFrame[] = [];

    for (const [path, content] of Object.entries(files)) {
      if (!this.syncable(path)) continue;
      const size = new TextEncoder().encode(content).length;
      // Listed only if it could actually be sent. A manifest entry the gateway
      // will ask for and then refuse is a round trip that ends in a `skipped`.
      if (size > LIMITS.maxSyncFileBytes) continue;
      // Deliberately not recorded as a base hash. `base` means "what both
      // sides last agreed this file holds", and nothing has been agreed yet —
      // seeding it from the editor's own content made every first push look
      // like an unchanged file and sent nothing at all.
      manifest.push({ path, hash: await hashContent(content), size });
    }

    this.options.terminal.sendManifest(manifest.slice(0, LIMITS.maxManifestFiles));
  }

  /** The gateway's answer: send exactly these, and argue about the rest. */
  async onPlan(plan: {
    needed: string[];
    diverged: Array<{ path: string; containerHash: string }>;
    skipped: Array<{ path: string; reason: string }>;
  }): Promise<void> {
    if (plan.skipped.length) this.options.onSkipped?.(plan.skipped);
    for (const path of plan.needed) this.dirty.add(path);

    // A file both sides already hold, differently. Pushing it would overwrite
    // whichever version the person did not pick, so it is a conflict on the
    // same terms as a concurrent write — reported, not resolved.
    const files = this.options.files();
    for (const entry of plan.diverged) {
      const content = files[entry.path];
      if (content === undefined) continue;
      this.options.onConflict({
        path: entry.path,
        containerHash: entry.containerHash,
        editorHash: await hashContent(content),
      });
    }

    this.flushSoon();
  }

  /** A path the editor changed. Cheap, and safe to call on every keystroke. */
  noteChange(path: string): void {
    if (!this.started || !this.syncable(path)) return;
    this.removed.delete(path);
    this.dirty.add(path);
    this.flushSoon();
  }

  noteDelete(path: string): void {
    if (!this.started || !this.syncable(path)) return;
    this.dirty.delete(path);
    this.base.delete(path);
    this.applied.delete(path);
    this.removed.add(path);
    this.flushSoon();
  }

  /**
   * Changes from the container.
   *
   * Filtered by the editor's own path rules before anything is applied. The
   * gateway is more trusted than a browser but it is not trusted: a frame that
   * names `.env` or a path outside the project is dropped here, so a confused
   * or compromised gateway cannot make the editor author into a protected file.
   */
  onChanged(
    files: Array<{ path: string; content: string; hash: string }>,
    deleted: string[],
  ): void {
    const safeFiles = files.filter((file) => this.syncable(file.path));
    const safeDeleted = deleted.filter((path) => this.syncable(path));

    for (const file of safeFiles) {
      this.applied.set(file.path, file.hash);
      this.base.set(file.path, file.hash);
    }
    for (const path of safeDeleted) {
      this.base.delete(path);
      this.applied.delete(path);
    }

    if (safeFiles.length || safeDeleted.length) {
      this.options.applyFromContainer(
        safeFiles.map(({ path, content }) => ({ path, content })),
        safeDeleted,
      );
    }
  }

  /** The outcome of a push. Conflicts are the only part with anywhere to go. */
  onAck(
    results: Array<
      | { status: 'written' | 'unchanged'; path: string; hash: string }
      | { status: 'skipped'; path: string; reason: string }
      | { status: 'conflict'; path: string; containerHash: string; editorHash: string }
    >,
  ): void {
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const result of results) {
      switch (result.status) {
        case 'written':
        case 'unchanged':
          // Now agreed, so this hash is what the next conflict check compares.
          this.base.set(result.path, result.hash);
          break;
        case 'skipped':
          skipped.push({ path: result.path, reason: result.reason });
          break;
        case 'conflict':
          this.options.onConflict(result);
          break;
      }
    }
    if (skipped.length) this.options.onSkipped?.(skipped);
  }

  /** A storm: the gateway gave up enumerating. Start over from a manifest. */
  onStorm(): void {
    this.dirty.clear();
    this.removed.clear();
    void this.start();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
    this.dirty.clear();
    this.removed.clear();
  }

  private flushSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  /** Everything pending, as one batch. Exposed so a save can force it. */
  async flush(): Promise<void> {
    if (!this.started) return;
    const paths = [...this.dirty];
    const deletes = [...this.removed];
    this.dirty.clear();
    this.removed.clear();

    if (deletes.length) this.options.terminal.deleteFiles(deletes);
    if (!paths.length) return;

    const files = this.options.files();
    const payload: Array<{ path: string; content: string; baseHash?: string }> = [];

    for (const path of paths) {
      const content = files[path];
      if (content === undefined) continue;
      if (new TextEncoder().encode(content).length > LIMITS.maxSyncFileBytes) continue;
      const hash = await hashContent(content);

      // Our own echo: this is exactly what the container just told us the file
      // holds, so sending it back is the loop this design exists to prevent.
      if (this.applied.get(path) === hash) {
        this.applied.delete(path);
        continue;
      }
      // Unchanged since the last agreement. Not an echo, just nothing to say.
      if (this.base.get(path) === hash) continue;

      payload.push({ path, content, baseHash: this.base.get(path) });
    }

    if (payload.length) this.options.terminal.pushFiles(payload);
  }

  private syncable(path: string): boolean {
    try {
      // The editor's own path choke point, not a second implementation of it.
      return normalizePath(path) === path && !isSensitivePath(path);
    } catch {
      return false;
    }
  }
}
