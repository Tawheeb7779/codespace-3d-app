import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { normalizePath, PathError } from './workspace.ts';

/**
 * Filesystem access that cannot be redirected after it has been checked.
 *
 * `resolveInWorkspaceNoSymlinks` walks a path and refuses one that crosses a
 * link, and it is still the first gate every caller here passes through. What
 * it cannot do is make its answer keep being true: it returns a *string*, and
 * between that check and the `writeFile` that follows, a process inside the
 * container can replace a directory component with a symbolic link. The write
 * then lands wherever the link points. That is the whole of the classic
 * check-then-use race, and the container is a shell the user controls, so the
 * window is not theoretical.
 *
 * The fix is to stop naming the target. Each directory on the way down is
 * opened with `O_NOFOLLOW` and its descriptor is held until the operation
 * finishes; the next component is opened *relative to the descriptor we
 * already hold*, spelled `/proc/self/fd/<fd>/<name>`. A descriptor refers to
 * the object it was opened on, not to a name, so swapping the name afterwards
 * changes nothing about where the bytes go. A component that has become a link
 * cannot be opened at all, and the operation fails rather than following it.
 *
 * This is Linux-specific by construction — it needs procfs, and the gateway's
 * container runtimes are Linux. Where procfs is missing the `open` simply
 * fails, which is the direction a security boundary should fail in.
 *
 * These functions replace the raw `fs` calls in `sync.ts` and `transfer.ts`.
 * They do not replace `normalizePath`, `isSensitivePath`, `shouldSync` or
 * `resolveInWorkspaceNoSymlinks`, all of which still run first: this closes the
 * race those checks cannot close, and they refuse the paths this cannot judge.
 */

/** Opened on every directory we descend through, and on the root itself. */
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Descend to a path's parent directory holding a descriptor on every step, then
 * hand the action a name that resolves through the descriptor rather than
 * through the filesystem's own tree.
 *
 * `create` makes the intermediate directories, which a write needs and a read
 * must not do. A directory this creates is chowned to match the workspace root,
 * so a tree built by a gateway-side write stays owned by the container's user
 * rather than by whoever the gateway runs as.
 */
export async function withParent<T>(
  root: string,
  path: string,
  create: boolean,
  action: (target: string, owner: { uid: number; gid: number }) => Promise<T>,
): Promise<T> {
  const parts = normalizePath(path).split('/');
  const handles: FileHandle[] = [];

  try {
    // The root may legitimately be reached through a link — a workspace root
    // that is a symlink onto another volume is an ordinary deployment — so it
    // is resolved once here, and nothing below it is allowed to be one.
    let parent = await open(await realpath(root), DIRECTORY_FLAGS);
    handles.push(parent);
    const owner = await parent.stat();

    for (const part of parts.slice(0, -1)) {
      const child = `/proc/self/fd/${parent.fd}/${part}`;
      let created = false;

      if (create) {
        try {
          await mkdir(child);
          created = true;
        } catch (error) {
          // Already there is the normal case, and not an error. Anything else
          // is, including a component that is a file rather than a directory.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }

      parent = await open(child, DIRECTORY_FLAGS);
      handles.push(parent);

      if (created) {
        const info = await parent.stat();
        if (info.uid !== owner.uid || info.gid !== owner.gid) {
          await parent.chown(owner.uid, owner.gid);
        }
      }
    }

    return await action(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    // What `O_NOFOLLOW` reports when the component it was told not to follow is
    // a link, and what the kernel reports when it is a file. Both mean the same
    // thing to a caller: the path is not the shape it must be.
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new PathError('path crosses a symbolic link or non-directory');
    }
    throw error;
  } finally {
    // Deepest first, so a descriptor is never held longer than the one it was
    // opened through.
    for (const handle of handles.reverse()) await handle.close();
  }
}

/**
 * Read a file through a descriptor already opened on it.
 *
 * The checks are on the descriptor rather than on the path, which is the point:
 * by the time this runs there is no name left to swap.
 *
 * `nlink !== 1` refuses a hard link. A link cannot be detected by walking the
 * path — it is the same inode under two names, with nothing to see at either —
 * so a second name inside the workspace would otherwise be a way to read or
 * rewrite a file the path checks were never asked about.
 *
 * The size is checked twice, before and after, because a file being written
 * while it is read yields a prefix of one version and a suffix of another. A
 * short read is refused rather than returned, since a truncated file that looks
 * complete is worse to the editor than an error it can retry.
 */
export async function readHandle(handle: FileHandle, limit: number): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) throw new PathError('not a regular single-link file');
  if (info.size > limit) throw new PathError('file exceeds the size limit');

  // One byte past the limit, so a file that grew past it during the read is
  // detected rather than silently truncated to the limit.
  const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
  let size = 0;
  while (size < buffer.length) {
    const read = await handle.read(buffer, size, buffer.length - size, size);
    if (!read.bytesRead) break;
    size += read.bytesRead;
  }

  if (size > limit) throw new PathError('file exceeds the size limit');
  if (size > info.size || (await handle.stat()).size !== size) {
    throw new PathError('file changed while reading; retry');
  }
  return buffer.subarray(0, size);
}

/** The file's bytes, or null when it is not there. Anything else throws. */
export async function readWorkspaceFile(
  root: string,
  path: string,
  limit: number,
): Promise<Buffer | null> {
  try {
    return await withParent(root, path, false, async (target) => {
      // `O_NONBLOCK` so a FIFO left in the tree cannot hang the gateway on open;
      // `readHandle` then refuses it for not being a regular file.
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        return await readHandle(handle, limit);
      } finally {
        await handle.close();
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write a file, deciding what to do about its current contents while holding
 * the descriptor that produced them.
 *
 * `decide` receives what is on disk — null when the file did not exist — and
 * returns either a value, meaning "do not write, this is the answer", or null,
 * meaning "go ahead". Reading and writing through one descriptor is what makes
 * a conflict check meaningful: a caller that read the file, decided, and then
 * wrote by name would be deciding about a file that may no longer be the one it
 * writes to.
 */
export async function writeWorkspaceFile<T>(
  root: string,
  path: string,
  content: Buffer,
  decide: (current: Buffer | null) => Promise<T | null> | T | null,
  limit: number,
): Promise<T | null> {
  return withParent(root, path, true, async (target, owner) => {
    let created = false;
    let handle: FileHandle;

    try {
      // `O_CREAT | O_EXCL` refuses to follow a link at the final component on
      // its own — it fails with EEXIST rather than opening what the link points
      // at — so this path is safe without `O_NOFOLLOW`, and the fallback below
      // carries it for the case where the file is really there.
      handle = await open(
        target,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      handle = await open(
        target,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    }

    try {
      const previous = created ? null : await readHandle(handle, limit);
      const decision = await decide(previous);
      if (decision !== null) return decision;

      if (created) {
        const info = await handle.stat();
        if (info.uid !== owner.uid || info.gid !== owner.gid) {
          await handle.chown(owner.uid, owner.gid);
        }
      }

      await handle.writeFile(content);
      // Shorter content would otherwise leave the tail of the old file behind.
      await handle.truncate(content.length);
      await handle.sync();
      return null;
    } finally {
      await handle.close();
    }
  });
}

/** Remove a file. A path that is already gone is not a failure. */
export async function deleteWorkspaceFile(root: string, path: string): Promise<void> {
  try {
    await withParent(root, path, false, async (target) => {
      await unlink(target);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
