/**
 * Going back to how the project was, and being clear about what that is not.
 *
 * **This is not deterministic time-travel debugging.** That would mean
 * replaying the application's execution — every event, every timer, every
 * network answer — and stepping through it backwards. It needs a runtime that
 * records and re-drives execution, and the preview here is an ordinary browser
 * frame in a sandbox: nothing in this architecture can do that, and a panel
 * claiming otherwise would be a lie about the most technically-loaded phrase in
 * the product.
 *
 * What this *is* is real and useful: the project's files are snapshotted at
 * moments that matter, alongside the events recorded around them, so a person
 * can see how the code looked before a change, what happened next, and diff or
 * restore it. It answers "what did I break, and when" — which is the question
 * people are usually asking when they reach for a debugger.
 *
 * **Recording is bounded on purpose.** A snapshot per keystroke would be a copy
 * of the project per keystroke; the caps below are what keep this from becoming
 * the reason the editor is slow.
 */

/** Snapshots kept. Beyond this the oldest is dropped. */
export const MAX_SNAPSHOTS = 12;

/** Largest single file stored in a snapshot. A bundle is not source. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Total across all snapshots, after which the oldest are dropped. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export type SnapshotReason =
  /** Before the agent applied changes. */
  | 'agent-task'
  /** A build completed. */
  | 'build'
  /** A commit was made. */
  | 'commit'
  /** Somebody pressed the button. */
  | 'manual';

export const REASON_LABEL: Record<SnapshotReason, string> = {
  'agent-task': 'Before the assistant made changes',
  build: 'Build',
  commit: 'Commit',
  manual: 'Marked by hand',
};

export interface Snapshot {
  id: string;
  at: number;
  reason: SnapshotReason;
  /** What was happening, in a few words. */
  label: string;
  /** The project's files as they were. Capped per file; see MAX_FILE_BYTES. */
  files: Record<string, string>;
  /** Files that were too large to store, named so the gap is visible. */
  skipped: string[];
  /** Bytes this snapshot holds. */
  bytes: number;
}

/**
 * Take a snapshot, skipping what is too large to keep.
 *
 * A skipped file is *named* rather than silently dropped: a restore that
 * quietly left a file at its current version would be a restore that did not
 * restore, and somebody would trust it.
 */
export function captureSnapshot(
  files: Record<string, string>,
  reason: SnapshotReason,
  label: string,
  id: string,
  at: number,
): Snapshot {
  const kept: Record<string, string> = {};
  const skipped: string[] = [];
  let bytes = 0;

  for (const [path, content] of Object.entries(files)) {
    if (content.length > MAX_FILE_BYTES) {
      skipped.push(path);
      continue;
    }
    kept[path] = content;
    bytes += content.length + path.length;
  }

  return { id, at, reason, label, files: kept, skipped, bytes };
}

/** Drop the oldest until the history fits its caps. */
export function trimHistory(snapshots: Snapshot[]): Snapshot[] {
  const kept = [...snapshots].sort((a, b) => b.at - a.at).slice(0, MAX_SNAPSHOTS);
  let total = kept.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  while (kept.length > 1 && total > MAX_TOTAL_BYTES) {
    const dropped = kept.pop()!;
    total -= dropped.bytes;
  }
  return kept;
}

export interface FileChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
}

/**
 * What changed between a snapshot and the project as it is now.
 *
 * A file the snapshot skipped is not reported as unchanged — there is no
 * recorded version to compare, and saying "unchanged" would be an answer this
 * does not have.
 */
export function diffAgainst(
  snapshot: Snapshot,
  current: Record<string, string>,
): { changes: FileChange[]; unknown: string[] } {
  const changes: FileChange[] = [];
  const skipped = new Set(snapshot.skipped);
  const paths = new Set([...Object.keys(snapshot.files), ...Object.keys(current)]);

  for (const path of paths) {
    if (skipped.has(path)) continue;
    const before = snapshot.files[path];
    const after = current[path];
    if (before === undefined && after !== undefined) changes.push({ path, kind: 'added' });
    else if (before !== undefined && after === undefined) changes.push({ path, kind: 'removed' });
    else if (before !== after) changes.push({ path, kind: 'changed' });
  }

  return {
    changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
    unknown: [...skipped].sort(),
  };
}

/**
 * What restoring would actually do.
 *
 * Computed and shown before anything is written, because a restore overwrites
 * work: the person has to see which files change and which cannot be restored
 * at all before deciding, not afterwards.
 */
export interface RestorePlan {
  /** Files that would be written back. */
  willWrite: string[];
  /** Files created since the snapshot, which would be deleted. */
  willDelete: string[];
  /** Files the snapshot never held, which will be left exactly as they are. */
  cannotRestore: string[];
}

export function planRestore(
  snapshot: Snapshot,
  current: Record<string, string>,
): RestorePlan {
  const skipped = new Set(snapshot.skipped);
  const willWrite: string[] = [];
  const willDelete: string[] = [];

  for (const [path, content] of Object.entries(snapshot.files)) {
    if (current[path] !== content) willWrite.push(path);
  }
  for (const path of Object.keys(current)) {
    if (!(path in snapshot.files) && !skipped.has(path)) willDelete.push(path);
  }

  return {
    willWrite: willWrite.sort(),
    willDelete: willDelete.sort(),
    // Named, not hidden: these keep their current contents whatever the
    // snapshot said, and a restore that pretended otherwise would be trusted.
    cannotRestore: [...skipped].sort(),
  };
}

/**
 * The prompt that asks the agent what went wrong between two points.
 *
 * Carries the files that changed and the events recorded in between — what was
 * actually observed. It asks for a diagnosis grounded in that, and to say when
 * the record is not enough, because a confident wrong answer about where a bug
 * entered sends somebody down the wrong path for an afternoon.
 */
export function divergencePrompt(
  snapshot: Snapshot,
  changes: FileChange[],
  events: Array<{ source: string; title: string }>,
): string {
  return [
    `Something changed between "${snapshot.label}" and now, and I want to know what broke.`,
    '',
    `Files that differ since that point (${changes.length}):`,
    ...changes.slice(0, 40).map((change) => `  ${change.kind}: ${change.path}`),
    '',
    events.length ? 'Events recorded since then, newest first:' : 'No events were recorded in between.',
    ...events.slice(0, 30).map((event) => `  [${event.source}] ${event.title}`),
    '',
    'Read the files that changed and say what most likely broke and why. Base it on the diff and',
    'these events — if they are not enough to tell, say so and say what would be, rather than',
    'naming a cause that merely fits.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
