import { useFileStore } from '@/stores/fileStore';
import { toast } from '@/stores/toastStore';
import { changedPaths, hasRemovals } from '@/lib/modelSync';
import { WorkspaceSync } from '@/lib/terminal/workspaceSync';
import type { ContainerTerminal } from '@/lib/terminal/containerClient';

/**
 * The sync engine, wired to the store the editor actually edits.
 *
 * `workspaceSync.ts` is deliberately ignorant of Zustand and of TA CODE's
 * stores so it can be tested against the real gateway without a browser. This
 * is the adapter that gives it the project: it watches the file store for
 * changes, hands container-originated changes back through the store's own
 * write path, and surfaces conflicts where a person will see them.
 *
 * One engine per project, not per terminal tab. Two tabs share one container
 * and therefore one filesystem; a second engine over the same tree would push
 * every change twice and see its own writes as the other's.
 *
 * Going through `writeFile` rather than setting state directly is the point of
 * the adapter. That path is where the VFS guards live — protected paths, path
 * normalisation, the read-only role — and a file arriving from a container is
 * exactly the input those guards exist for.
 */

interface Attachment {
  sync: WorkspaceSync;
  detach: () => void;
}

const attached = new Map<string, Attachment>();

export function workspaceSyncFor(projectId: string): WorkspaceSync | null {
  return attached.get(projectId)?.sync ?? null;
}

/**
 * Begin synchronising a project with its container.
 *
 * Idempotent per project: a second terminal tab joins the existing engine
 * rather than starting another.
 */
export function attachWorkspaceSync(
  projectId: string,
  client: Pick<ContainerTerminal, 'sendManifest' | 'pushFiles' | 'deleteFiles' | 'containerId'>,
): WorkspaceSync {
  const existing = attached.get(projectId);
  if (existing) return existing.sync;

  const sync = new WorkspaceSync({
    terminal: client,
    files: () => useFileStore.getState().files,

    applyFromContainer: (files, deleted) => {
      const store = useFileStore.getState();
      // A viewer's editor must not be written into by a container either. The
      // store would refuse each call anyway; checking once keeps a `git
      // checkout` from raising several hundred identical errors.
      if (!store.canWrite()) return;

      for (const file of files) {
        try {
          store.writeFile(file.path, file.content);
        } catch {
          // A path the VFS refuses. The gateway filters these too, so reaching
          // here means the two disagree — drop the file, keep the session.
        }
      }
      for (const path of deleted) {
        try {
          if (useFileStore.getState().files[path] !== undefined) store.remove(path);
        } catch {
          /* already gone, or not ours to remove */
        }
      }
    },

    onConflict: (conflict) => {
      // Named, and not resolved. Whichever version this discarded would be an
      // hour of somebody's work, and the engine has no way to know whose.
      toast.error(
        `"${conflict.path}" changed in the terminal and in the editor. The terminal's version was kept; copy your editor changes before saving again.`,
      );
    },

    onSkipped: (skipped) => {
      // Once, with a count: a project can legitimately contain hundreds of
      // files that will never cross, and a toast each would bury the editor.
      const [first] = skipped;
      if (!first) return;
      toast.info(
        skipped.length === 1
          ? `"${first.path}" was not sent to the terminal: ${first.reason}.`
          : `${skipped.length} files were not sent to the terminal, including "${first.path}": ${first.reason}.`,
      );
    },
  });

  // The store replaces its file map on every write but keeps the identical
  // string for untouched files, so finding what changed is a pointer check per
  // file rather than a comparison of the project's text. The same property the
  // editor's model sync relies on.
  let previous = useFileStore.getState().files;
  const unsubscribe = useFileStore.subscribe((state) => {
    const next = state.files;
    if (next === previous) return;
    const before = previous;
    previous = next;

    for (const path of changedPaths(before, next)) sync.noteChange(path);
    if (hasRemovals(before, next)) {
      for (const path in before) {
        if (!(path in next)) sync.noteDelete(path);
      }
    }
  });

  attached.set(projectId, { sync, detach: unsubscribe });
  return sync;
}

export function detachWorkspaceSync(projectId?: string): void {
  for (const [id, entry] of attached) {
    if (projectId && id !== projectId) continue;
    entry.detach();
    entry.sync.stop();
    attached.delete(id);
  }
}
