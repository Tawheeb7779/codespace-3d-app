import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { liveWorkspace } from '@/components/ide/ContainerTerminal';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import {
  describeTransfer,
  planUploads,
  type UploadCandidate,
  type UploadOutcome,
} from '@/lib/linux/uploads';

/**
 * Files put into the Linux workspace, and the one deliberate way out of it.
 *
 * The Linux workspace is a separate container with its own directory. Nothing
 * of the project is mounted into it and nothing of it is mounted into the
 * project, so an uploaded file cannot reach the source tree by drifting there —
 * it takes the gateway's explicit transfer, which authorises both endpoints and
 * refuses to overwrite. That is what "Use in project" runs, and the result it
 * reports is the gateway's own, including the files it did not copy.
 *
 * What is remembered here is the *list* of uploads, not their contents: the
 * files live in the workspace, which is where they are supposed to live. The
 * list survives a reload so a person coming back can still find what they put
 * there, and it is scoped to nothing else because the Linux workspace belongs
 * to the person rather than to a project.
 */

export interface UploadRecord {
  path: string;
  size: number;
  at: number;
  /** Set once this file has been copied into a project, and which. */
  usedIn?: string;
}

interface LinuxFilesState {
  uploads: UploadRecord[];
  busy: boolean;
  /** What the last operation actually did, in the past tense. */
  result: string | null;
  problem: string | null;

  upload: (candidates: UploadCandidate[]) => void;
  copyIntoProject: (paths: string[]) => Promise<void>;
  forget: (path: string) => void;
  clearResult: () => void;
}

/** How long the gateway is given to answer a transfer before it is abandoned. */
const TRANSFER_TIMEOUT_MS = 30_000;

export const useLinuxFilesStore = create<LinuxFilesState>()(
  persist(
    (set, get) => ({
      uploads: [],
      busy: false,
      result: null,
      problem: null,

      upload(candidates) {
        const client = liveWorkspace('linux');
        if (!client) {
          set({
            problem:
              'The Linux Terminal is not connected, so there is nowhere to put these. Open it first.',
            result: null,
          });
          return;
        }

        const { push, outcome } = planUploads(candidates);
        if (push.length) client.client.pushFiles(push);

        set((state) => ({
          // Re-uploading a name replaces its record rather than listing it twice.
          uploads: [
            ...state.uploads.filter(
              (record) => !outcome.uploaded.some((entry) => entry.path === record.path),
            ),
            ...outcome.uploaded.map((entry) => ({ path: entry.path, size: entry.size, at: Date.now() })),
          ].sort((a, b) => a.path.localeCompare(b.path)),
          result: summariseUpload(outcome),
          problem: outcome.refused.length
            ? outcome.refused.map((entry) => `${entry.name}: ${entry.reason}`).join(' ')
            : null,
          busy: false,
        }));
      },

      async copyIntoProject(paths) {
        if (get().busy || !paths.length) return;

        const projectId = useFileStore.getState().meta?.id ?? null;
        const linux = liveWorkspace('linux');
        const project = projectId ? liveWorkspace('project', projectId) : null;

        // Both ends are required, and which one is missing is worth saying:
        // "not connected" sends somebody to the wrong terminal half the time.
        if (!linux) {
          set({ problem: 'The Linux Terminal is not connected.', result: null });
          return;
        }
        if (!project) {
          set({
            problem:
              'This project has no container workspace open. Open the project’s container terminal so there is somewhere to copy into.',
            result: null,
          });
          return;
        }

        set({ busy: true, problem: null, result: null });

        try {
          const outcome = await linux.client.transferAndWait(project.containerId, paths, {
            timeoutMs: TRANSFER_TIMEOUT_MS,
          });

          set((state) => ({
            busy: false,
            result: describeTransfer(outcome),
            uploads: state.uploads.map((record) =>
              outcome.copied.includes(record.path)
                ? { ...record, usedIn: useFileStore.getState().meta?.name ?? 'this project' }
                : record,
            ),
          }));

          // The container's watcher brings the copy back into the editor's
          // filesystem; opening it is only worth doing once it is actually
          // there, so this checks rather than assuming.
          const first = outcome.copied[0];
          if (first && useFileStore.getState().files[first] !== undefined) {
            useEditorStore.getState().openTab(first);
          }
        } catch (failure) {
          set({
            busy: false,
            problem: failure instanceof Error ? failure.message : 'The transfer failed.',
          });
        }
      },

      forget: (path) =>
        set((state) => ({ uploads: state.uploads.filter((record) => record.path !== path) })),

      clearResult: () => set({ result: null, problem: null }),
    }),
    {
      name: 'tacode.linux-files',
      // The list, never a status: `busy` and the last result belong to a
      // session, and a page that reloaded mid-transfer must not come back
      // claiming one is still running.
      partialize: (state) => ({ uploads: state.uploads }),
    },
  ),
);

function summariseUpload(outcome: UploadOutcome): string {
  if (!outcome.uploaded.length) return 'Nothing was uploaded.';
  const count = outcome.uploaded.length;
  return `Uploaded ${count} file${count === 1 ? '' : 's'} into the Linux workspace.`;
}
