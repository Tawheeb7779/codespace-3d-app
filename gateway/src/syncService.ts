import { stat } from 'node:fs/promises';
import { LIMITS, type ServerFrame } from '../../src/lib/terminal/protocol.ts';
import type { GatewayConfig } from './config.ts';
import type { ContainerRecord } from './lifecycle.ts';
import type { Logger } from './observability.ts';
import {
  applyEditorDelete,
  applyEditorWrite,
  containerManifest,
  planInitialSync,
  readContainerChange,
  type ManifestEntry,
  type SyncLimits,
} from './sync.ts';
import { resolveInWorkspace } from './workspace.ts';
import { WorkspaceWatcher, walkWorkspace } from './watcher.ts';

/**
 * The sync engine, connected to sockets.
 *
 * `sync.ts` decides what a single change means — whether it is an echo, a
 * conflict, or a write. This decides *when* those decisions happen and who
 * hears about them: it owns one watcher per container, the set of browsers
 * listening to it, and the batching that keeps a build from turning into
 * ninety thousand frames.
 *
 * One watcher per container, not per connection. Two tabs on the same project
 * share a container, and a second inotify tree over the same directory would
 * double the kernel's work to deliver each browser the same event.
 *
 * A subscriber is a function, not a socket. It keeps this module testable
 * without a WebSocket, and it means the server decides what "send" costs —
 * backpressure and encoding stay in one place.
 */

export type SyncSubscriber = (frame: ServerFrame) => void;

interface Watched {
  watcher: WorkspaceWatcher;
  subscribers: Set<SyncSubscriber>;
  /** Serialises the reads a burst triggers, so a build cannot fan out unboundedly. */
  draining: Promise<void>;
}

export class SyncService {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {}

  private get limits(): SyncLimits {
    // The gateway's policy, floored by the protocol's ceiling: a file the wire
    // cannot carry must not be one this layer decides to send, or every batch
    // containing it fails to encode.
    return {
      maxFileBytes: Math.min(this.config.maxSyncFileBytes, LIMITS.maxSyncFileBytes),
      maxFiles: Math.min(this.config.maxSyncFiles, LIMITS.maxManifestFiles),
    };
  }

  /**
   * Answer a manifest with the subset the container is missing.
   *
   * The container's side is read from disk, not from the index — see
   * {@link containerManifest} for why.
   */
  async plan(record: ContainerRecord, editorManifest: ManifestEntry[]): Promise<ServerFrame> {
    const { paths } = await walkWorkspace(record.workspaceDir, this.limits.maxFiles);
    const present = await containerManifest(record.workspaceDir, paths, this.limits);
    const plan = planInitialSync(editorManifest, present, this.limits);

    // Seed the index with what is already there, so the first watcher event
    // for an untouched file is recognised as the echo it is.
    for (const entry of present) record.index.record(entry.path, entry.hash, entry.size, 'container');

    // The count, never the paths. A file's name is the user's content, and a
    // log line is the easiest place for content to end up somewhere it should
    // not be.
    this.logger.event('sync_started', {
      containerId: record.id,
      userId: record.userId,
      files: plan.needed.length,
    });

    return { type: 'sync-plan', containerId: record.id, ...plan };
  }

  async push(
    record: ContainerRecord,
    files: Array<{ path: string; content: string; baseHash?: string }>,
  ): Promise<ServerFrame> {
    const results = [];
    for (const file of files) {
      const outcome = await applyEditorWrite(record.workspaceDir, record.index, file, this.limits);
      results.push(outcome);
      if (outcome.status === 'conflict') {
        this.logger.event('sync_conflict', { containerId: record.id, userId: record.userId });
      }
    }
    return { type: 'sync-ack', containerId: record.id, results };
  }

  async remove(record: ContainerRecord, paths: string[]): Promise<ServerFrame> {
    const results = [];
    for (const path of paths) {
      results.push(await applyEditorDelete(record.workspaceDir, record.index, path));
    }
    return { type: 'sync-ack', containerId: record.id, results };
  }

  /** Start listening to this container's filesystem, if nobody was already. */
  subscribe(record: ContainerRecord, subscriber: SyncSubscriber): void {
    let entry = this.watched.get(record.id);
    if (!entry) {
      const created: Watched = {
        watcher: new WorkspaceWatcher(record.workspaceDir, {
          onEvents: (events) => {
            created.draining = created.draining
              .then(() => this.drain(record, events.map((event) => event.path)))
              .catch(() => undefined);
          },
          onStorm: (count) => {
            this.logger.event('sync_storm', { containerId: record.id, files: count });
            this.broadcast(record.id, { type: 'sync-storm', containerId: record.id, count });
          },
        }),
        subscribers: new Set(),
        draining: Promise.resolve(),
      };
      created.watcher.start();
      this.watched.set(record.id, created);
      entry = created;
    }
    entry.subscribers.add(subscriber);
  }

  unsubscribe(containerId: string, subscriber: SyncSubscriber): void {
    const entry = this.watched.get(containerId);
    if (!entry) return;
    entry.subscribers.delete(subscriber);
    // The last browser left. Keep nothing running for a workspace nobody is
    // watching — an inotify tree per abandoned container is how a gateway runs
    // out of watch descriptors.
    if (entry.subscribers.size === 0) this.stop(containerId);
  }

  stop(containerId: string): void {
    const entry = this.watched.get(containerId);
    if (!entry) return;
    entry.watcher.stop();
    this.watched.delete(containerId);
  }

  stopAll(): void {
    for (const containerId of [...this.watched.keys()]) this.stop(containerId);
  }

  /**
   * Turn a burst of watcher events into change frames.
   *
   * Deletions are separated from writes because they are answered differently:
   * a path that no longer exists has no content to send, and the index must
   * forget it or its hash will suppress a later recreation as an echo.
   */
  private async drain(record: ContainerRecord, paths: string[]): Promise<void> {
    if (!this.watched.has(record.id)) return;

    const files: Array<{ path: string; content: string; hash: string }> = [];
    const deleted: string[] = [];

    for (const path of paths) {
      const target = resolveInWorkspace(record.workspaceDir, path);
      const exists = await stat(target).then(
        (info) => info.isFile(),
        () => false,
      );
      if (!exists) {
        // Only report a deletion of something we believed was there. A watcher
        // fires for temp files that never existed as far as the editor knows,
        // and telling it to delete those is noise at best.
        if (record.index.get(path)) {
          record.index.forget(path);
          deleted.push(path);
        }
        continue;
      }
      // Returns null for an echo of the editor's own write, which is the case
      // that stops the loop editor -> container -> watcher -> editor.
      const change = await readContainerChange(record.workspaceDir, record.index, path, this.limits);
      if (change) files.push(change);
    }

    if (!files.length && !deleted.length) return;

    for (const batch of batched(files, deleted, LIMITS.maxSyncBatchFiles)) {
      this.broadcast(record.id, { type: 'sync-changed', containerId: record.id, ...batch });
    }
  }

  private broadcast(containerId: string, frame: ServerFrame): void {
    const entry = this.watched.get(containerId);
    if (!entry) return;
    for (const subscriber of entry.subscribers) subscriber(frame);
  }
}

/**
 * Split a change set into frames that will encode.
 *
 * Two ceilings, and the byte one is the one that matters: sixty-four files of
 * a hundred kilobytes is a six-megabyte frame, which the peer refuses before
 * reading, so a single `git checkout` would silently deliver nothing.
 */
export function* batched(
  files: Array<{ path: string; content: string; hash: string }>,
  deleted: string[],
  maxFiles: number,
): Generator<{ files: Array<{ path: string; content: string; hash: string }>; deleted: string[] }> {
  // Leaves room for the envelope, the paths, and JSON's escaping of content.
  const maxBytes = Math.floor(LIMITS.maxFrameBytes / 2);
  let chunk: typeof files = [];
  let bytes = 0;

  for (const file of files) {
    const cost = file.content.length + file.path.length + 64;
    if (chunk.length >= maxFiles || (chunk.length > 0 && bytes + cost > maxBytes)) {
      yield { files: chunk, deleted: [] };
      chunk = [];
      bytes = 0;
    }
    chunk.push(file);
    bytes += cost;
  }

  // Deletions ride with the last batch of writes when there is room, and
  // otherwise get frames of their own — they are paths, so they are cheap.
  if (chunk.length || deleted.length) {
    const head = deleted.slice(0, maxFiles);
    yield { files: chunk, deleted: head };
    for (let offset = maxFiles; offset < deleted.length; offset += maxFiles) {
      yield { files: [], deleted: deleted.slice(offset, offset + maxFiles) };
    }
  }
}
