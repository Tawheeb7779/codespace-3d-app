import { LIMITS } from '@/lib/terminal/protocol';

/**
 * Files a person puts into their Linux workspace, kept out of the project.
 *
 * The separation is not a convention enforced here — it is the architecture.
 * A Linux workspace is a different container with a different directory,
 * authorised by identity rather than by project membership, and nothing is
 * mounted between them. An uploaded file therefore cannot land in the project's
 * source tree by accident; it takes an explicit transfer, which is a different
 * operation the gateway authorises on both ends.
 *
 * Within the Linux workspace uploads go under `uploads/`, so a person can tell
 * what they put there from what a command they ran produced.
 *
 * **The honest limit.** Files cross on the sync channel, which carries strings.
 * A binary would not survive that — it would arrive quietly corrupted, which is
 * worse than not arriving — so binaries are refused by name rather than
 * mangled, and the panel says to fetch them with `curl` or `git` inside the
 * workspace instead, where they stay bytes.
 */

/** Where uploads live inside the Linux workspace. */
export const UPLOAD_DIR = 'uploads';

/** The sync channel's own per-file ceiling; stated here so the refusal can be. */
export const MAX_UPLOAD_BYTES = LIMITS.maxSyncFileBytes;

export interface UploadCandidate {
  name: string;
  content: string;
  size: number;
}

export type UploadPlan =
  | { ok: true; path: string; content: string }
  | { ok: false; name: string; reason: string };

/**
 * A safe name inside the upload directory.
 *
 * Every separator is collapsed rather than resolved: an upload is one file
 * dropped into one directory, so `../` and nested paths have no meaning here,
 * and flattening is both simpler and impossible to walk out of. The gateway
 * resolves and refuses paths again on its side; this is the first of two
 * checks, not the only one.
 */
export function uploadPathFor(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  if (!safe || safe === '.' || safe === '..') return null;
  return `${UPLOAD_DIR}/${safe}`;
}

/**
 * Whether this content survived being read as text.
 *
 * A NUL byte is the giveaway, and so is the replacement character a decoder
 * leaves where it could not decode. Either means the bytes on screen are not
 * the bytes in the file.
 */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000') || content.includes('\uFFFD');
}

/** Decide what happens to one file, or why nothing does. */
export function planUpload(candidate: UploadCandidate): UploadPlan {
  const path = uploadPathFor(candidate.name);
  if (!path) {
    return { ok: false, name: candidate.name, reason: 'That name has no usable characters.' };
  }
  if (candidate.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      name: candidate.name,
      reason: `Larger than ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB, which is the limit on the sync channel. Fetch it inside the workspace with curl or git instead.`,
    };
  }
  if (looksBinary(candidate.content)) {
    return {
      ok: false,
      name: candidate.name,
      reason:
        'This is a binary file. Uploads cross as text, so it would arrive corrupted. Download it inside the workspace with curl or git instead.',
    };
  }
  return { ok: true, path, content: candidate.content };
}

/** Files one upload may carry, so a folder drop stays a bounded request. */
export const MAX_UPLOAD_FILES = LIMITS.maxSyncBatchFiles;

export interface UploadOutcome {
  uploaded: Array<{ path: string; size: number }>;
  refused: Array<{ name: string; reason: string }>;
}

export function planUploads(candidates: UploadCandidate[]): {
  push: Array<{ path: string; content: string }>;
  outcome: UploadOutcome;
} {
  const push: Array<{ path: string; content: string }> = [];
  const outcome: UploadOutcome = { uploaded: [], refused: [] };

  for (const candidate of candidates.slice(0, MAX_UPLOAD_FILES)) {
    const plan = planUpload(candidate);
    if (!plan.ok) {
      outcome.refused.push({ name: plan.name, reason: plan.reason });
      continue;
    }
    push.push({ path: plan.path, content: plan.content });
    outcome.uploaded.push({ path: plan.path, size: candidate.size });
  }

  for (const extra of candidates.slice(MAX_UPLOAD_FILES)) {
    outcome.refused.push({
      name: extra.name,
      reason: `Only ${MAX_UPLOAD_FILES} files can be uploaded at once.`,
    });
  }

  return { push, outcome };
}

/**
 * Where a transferred upload lands in the project, which is not a choice.
 *
 * The gateway's transfer resolves the *same relative path* in both workspaces,
 * so `uploads/notes.md` in the Linux workspace becomes `uploads/notes.md` in
 * the project. That happens to be the behaviour worth having — a file that came
 * from another machine stays visibly apart from `src/` rather than appearing
 * beside hand-written code — but the panel states it rather than implying the
 * destination can be picked.
 */
export function projectPathFor(uploadPath: string): string {
  return uploadPath;
}

/**
 * Describe a transfer's real outcome, including what did not happen.
 *
 * A conflict is the case worth wording carefully: nothing was overwritten, and
 * a summary that said "copied" for a file that was left alone is the difference
 * between the user having the file they think they have and not.
 */
export function describeTransfer(outcome: {
  copied: string[];
  conflicts: string[];
  skipped: Array<{ path: string; reason: string }>;
}): string {
  const parts: string[] = [];
  parts.push(
    outcome.copied.length
      ? `Copied ${outcome.copied.length} file${outcome.copied.length === 1 ? '' : 's'} into the project.`
      : 'Nothing was copied.',
  );
  if (outcome.conflicts.length) {
    parts.push(
      `${outcome.conflicts.length} already existed in the project and were left as they were: ${outcome.conflicts.join(', ')}.`,
    );
  }
  for (const skip of outcome.skipped) {
    parts.push(`${skip.path} was refused: ${skip.reason}`);
  }
  return parts.join(' ');
}
