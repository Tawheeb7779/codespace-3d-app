import { isSensitivePath, isTextFile, normalizePath, VfsError } from '@/lib/vfs';

/**
 * ZIP import/export.
 *
 * Import is the highest risk entry point in the product: an archive controls
 * both the paths and the contents that land in a workspace. Every entry is
 * re-normalised (blocking `../`, absolute paths and Windows separators),
 * screened against the sensitive-path policy, and capped in size.
 */

export const MAX_ARCHIVE_FILES = 3000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface ImportReport {
  files: Record<string, string>;
  dirs: string[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

/** Drop a shared top-level folder, the way GitHub zipballs are structured. */
export function stripCommonRoot(paths: string[]): (path: string) => string {
  if (paths.length < 2) return (p) => p;
  const first = paths[0].split('/')[0];
  if (!first) return (p) => p;
  const shared = paths.every((p) => p === first || p.startsWith(`${first}/`));
  if (!shared) return (p) => p;
  return (p) => (p === first ? p : p.slice(first.length + 1));
}

export async function importZip(data: ArrayBuffer | Blob): Promise<ImportReport> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);

  const entries = Object.values(zip.files);
  const rawPaths = entries.filter((e) => !e.dir).map((e) => e.name);
  const strip = stripCommonRoot(rawPaths);

  const files: Record<string, string> = {};
  const dirs = new Set<string>();
  const skipped: ImportReport['skipped'] = [];
  let totalBytes = 0;
  let accepted = 0;

  for (const entry of entries) {
    const relative = strip(entry.name).replace(/\/+$/, '');
    if (!relative) continue;

    let path: string;
    try {
      path = normalizePath(relative);
    } catch (error) {
      skipped.push({
        path: entry.name,
        reason: error instanceof VfsError ? error.message : 'Invalid path',
      });
      continue;
    }

    if (isSensitivePath(path)) {
      skipped.push({ path, reason: 'Blocked path (VCS, secrets, dependencies or build output)' });
      continue;
    }
    if (entry.dir) {
      dirs.add(path);
      continue;
    }
    if (!isTextFile(path)) {
      skipped.push({ path, reason: 'Binary or unsupported file type' });
      continue;
    }
    if (accepted >= MAX_ARCHIVE_FILES) {
      skipped.push({ path, reason: `Archive exceeds ${MAX_ARCHIVE_FILES} files` });
      continue;
    }

    const content = await entry.async('string');
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_FILE_BYTES) {
      skipped.push({ path, reason: `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      skipped.push({ path, reason: 'Archive exceeds the total size budget' });
      continue;
    }
    totalBytes += bytes;
    accepted += 1;
    files[path] = content;
  }

  if (!accepted) {
    throw new Error(
      skipped.length
        ? `No importable files found. ${skipped.length} entr${skipped.length === 1 ? 'y was' : 'ies were'} skipped — the archive may contain only binaries or blocked paths.`
        : 'The archive is empty.',
    );
  }

  return { files, dirs: [...dirs], skipped, totalBytes };
}

export async function exportZip(
  name: string,
  files: Record<string, string>,
  dirs: string[] = [],
): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const root = zip.folder(safeArchiveName(name)) ?? zip;
  for (const dir of dirs) {
    if (!isSensitivePath(dir)) root.folder(dir);
  }
  for (const [path, content] of Object.entries(files)) {
    // Never emit secrets or VCS internals into a shared artifact.
    if (isSensitivePath(path)) continue;
    root.file(path, content);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export function safeArchiveName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'forge-project';
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}

/**
 * Import a public GitHub repository through its zipball endpoint.
 * Private repositories are not supported: that would require holding a token
 * in the browser, which this app deliberately does not do.
 */
export async function fetchGithubZip(owner: string, repo: string, ref?: string): Promise<ArrayBuffer> {
  const clean = (value: string) => value.trim().replace(/^\/+|\/+$/g, '');
  const safeOwner = clean(owner);
  const safeRepo = clean(repo).replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(safeOwner) || !/^[\w.-]+$/.test(safeRepo)) {
    throw new Error('Enter a repository as owner/name, for example vercel/next.js');
  }
  const suffix = ref && /^[\w./-]+$/.test(ref) ? `/${ref}` : '';
  const url = `https://api.github.com/repos/${safeOwner}/${safeRepo}/zipball${suffix}`;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (response.status === 404) {
    throw new Error(`${safeOwner}/${safeRepo} was not found, or it is private.`);
  }
  if (response.status === 403) {
    throw new Error('GitHub rate limit reached for this network. Try again later.');
  }
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} for ${safeOwner}/${safeRepo}.`);
  }
  return response.arrayBuffer();
}

export function parseRepoSpec(input: string): { owner: string; repo: string; ref?: string } {
  const trimmed = input.trim();
  const urlMatch = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/.exec(
    trimmed,
  );
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2], ref: urlMatch[3] };
  const shortMatch = /^([\w.-]+)\/([\w.-]+?)(?:#([\w./-]+))?$/.exec(trimmed);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], ref: shortMatch[3] };
  throw new Error('Enter a repository as owner/name or a full GitHub URL.');
}
