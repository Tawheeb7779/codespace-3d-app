import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UNWATCHED_DIRECTORIES, shouldSync } from './workspace.ts';

/**
 * Noticing what the container did to the files.
 *
 * The hard part is not detecting changes, it is not detecting too many. A
 * single `npm install` writes tens of thousands of files; a webpack build
 * rewrites `dist` on every keystroke; `git checkout` touches the whole tree.
 * A watcher that reports all of that faithfully takes the gateway down.
 *
 * Three defences, in the order they matter:
 *
 *  1. **Do not watch it.** `node_modules`, `.git`, `dist` and friends are never
 *     descended into, so the events are never generated. Filtering after the
 *     fact still pays for the inotify watch and the event, and on Linux the
 *     watch descriptor limit is a real ceiling — a large monorepo's
 *     `node_modules` alone can exhaust it and break watching for everything.
 *  2. **Coalesce.** Events for one path inside the debounce window collapse to
 *     one. Editors write a file three times (temp, rename, touch) and build
 *     tools rewrite the same output repeatedly.
 *  3. **Cap.** Beyond a burst threshold the watcher stops reporting individual
 *     paths and reports that a storm happened, so the consumer can resynchronise
 *     from a manifest instead of processing a hundred thousand events one by
 *     one. Degrading loudly beats falling over quietly.
 *
 * `fs.watch` with `recursive: true` rather than a dependency: it is the same
 * inotify underneath on Linux, and a watcher is exactly the kind of component
 * whose behaviour should be legible in the file that uses it.
 */

export interface WatchEvent {
  path: string;
  kind: 'change' | 'rename';
}

export interface WatcherOptions {
  /** Events for the same path inside this window collapse into one. */
  debounceMs?: number;
  /** Paths per window above which the watcher reports a storm instead. */
  stormThreshold?: number;
  onEvents: (events: WatchEvent[]) => void;
  /** A storm means "resynchronise", not "here are 90,000 paths". */
  onStorm: (count: number) => void;
}

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private readonly pending = new Map<string, WatchEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowCount = 0;

  constructor(
    private readonly workspaceDir: string,
    private readonly options: WatcherOptions,
  ) {}

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.workspaceDir, { recursive: true }, (kind, filename) => {
        if (!filename) return;
        this.enqueue(String(filename), kind === 'rename' ? 'rename' : 'change');
      });
      // A watcher must never be the reason the process cannot exit.
      this.watcher.unref?.();
    } catch {
      // Recursive watching is not available on every platform. The feature
      // degrades to editor-driven sync rather than failing the session: a
      // terminal that cannot notice `touch foo` is still a working terminal.
      this.watcher = null;
    }
  }

  private enqueue(filename: string, kind: WatchEvent['kind']): void {
    const path = filename.split(sep).join('/');
    if (!shouldSync(path)) return;

    this.windowCount += 1;
    const threshold = this.options.stormThreshold ?? 500;
    if (this.windowCount > threshold) {
      this.pending.clear();
      this.schedule();
      return;
    }

    this.pending.set(path, { path, kind });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const storm = this.windowCount > (this.options.stormThreshold ?? 500);
      const events = [...this.pending.values()];
      const count = this.windowCount;
      this.pending.clear();
      this.windowCount = 0;

      if (storm) this.options.onStorm(count);
      else if (events.length) this.options.onEvents(events);
    }, this.options.debounceMs ?? 120);
    this.timer.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

/**
 * Every syncable file in a workspace, as a manifest.
 *
 * Walks with the same exclusions the watcher uses, so a directory nobody
 * watches is also a directory nobody enumerates — the alternative is a
 * `readdir` of `node_modules` on every reconnect.
 */
export async function walkWorkspace(
  workspaceDir: string,
  limit: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      const rel = relative(workspaceDir, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (UNWATCHED_DIRECTORIES.includes(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && shouldSync(rel)) {
        if (paths.length >= limit) {
          truncated = true;
          return;
        }
        paths.push(rel);
      }
    }
  };

  await walk(workspaceDir);
  return { paths, truncated };
}
