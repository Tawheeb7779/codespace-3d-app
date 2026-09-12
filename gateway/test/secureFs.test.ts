import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  withParent,
} from '../src/secureFs.ts';
import {
  SyncIndex,
  applyEditorWrite,
  applyEditorDelete,
  readContainerChange,
  containerManifest,
} from '../src/sync.ts';
import { transferFiles } from '../src/transfer.ts';
import type { ContainerRecord } from '../src/lifecycle.ts';
import { loadConfig } from '../src/config.ts';

/**
 * The race the path checks cannot win.
 *
 * `resolveInWorkspaceNoSymlinks` walks a path, refuses one that crosses a link,
 * and returns a string. Everything after that string is a fresh lookup, and the
 * container is a shell somebody is typing into: between the check and the
 * write, `mv` and `ln -s` are two commands. These tests do exactly that — they
 * swap a directory for a symlink *after* the check and *while* the operation is
 * in flight — and assert the bytes went where the check said they would.
 *
 * The path checks are not replaced by any of this. They run first, and their
 * own suites still cover them; what is tested here is the guarantee they cannot
 * make, which is that their answer is still true a moment later.
 */

const limits = { maxFileBytes: 128 * 1024, maxFiles: 100 };
const tier = loadConfig({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }).tiers
  .free;

function workspaceRecord(overrides: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 'tacode-' + 'a'.repeat(32),
    userId: 'user-amina',
    kind: 'project',
    projectId: 'proj-alpha',
    tier,
    status: 'ready',
    workspaceDir: '/tmp/nowhere',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    index: new SyncIndex(),
    openPorts: new Set(),
    ...overrides,
  };
}

/** A workspace root with somewhere outside it for an escape to aim at. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'tacode-securefs-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'must not be touched');
  return { root, workspace, outside };
}

describe('a directory swapped for a symlink mid-operation', () => {
  /**
   * The attack, run for real. The directory is renamed away and replaced by a
   * link to somewhere outside the workspace while the descriptor on it is still
   * open — which is the only moment at which it would have worked.
   */
  it('writes through the descriptor, not through the name that was replaced', async () => {
    const { root, workspace, outside } = await sandbox();
    try {
      await mkdir(join(workspace, 'folder'), { recursive: true });

      await withParent(workspace, 'folder/file', false, async (target) => {
        await rename(join(workspace, 'folder'), join(workspace, 'original'));
        await symlink(outside, join(workspace, 'folder'));
        await writeFile(target, 'inside');
      });

      // The bytes landed in the directory that was checked, under its new name.
      expect(await readFile(join(workspace, 'original/file'), 'utf8')).toBe('inside');
      // Nothing reached the target of the link.
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('must not be touched');
      const escaped = await readFile(join(outside, 'file'), 'utf8').catch(() => null);
      expect(escaped).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to read through a directory that has become a link', async () => {
    const { root, workspace, outside } = await sandbox();
    try {
      await symlink(outside, join(workspace, 'folder'));

      await expect(readWorkspaceFile(workspace, 'folder/secret.txt', 4096)).rejects.toThrow(
        /symbolic link|non-directory/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to write through a final component that is a link', async () => {
    const { root, workspace, outside } = await sandbox();
    try {
      await symlink(join(outside, 'secret.txt'), join(workspace, 'pointer.txt'));

      await expect(
        writeWorkspaceFile(workspace, 'pointer.txt', Buffer.from('overwritten'), () => null, 4096),
      ).rejects.toThrow();
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('must not be touched');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to delete through a directory that has become a link', async () => {
    const { root, workspace, outside } = await sandbox();
    try {
      await symlink(outside, join(workspace, 'folder'));

      await expect(deleteWorkspaceFile(workspace, 'folder/secret.txt')).rejects.toThrow(
        /symbolic link|non-directory/i,
      );
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('must not be touched');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('what a descriptor can check that a path cannot', () => {
  /**
   * A hard link is the same inode under a second name. Walking the path sees
   * nothing unusual at either name, so it can only be caught at the descriptor.
   */
  it('refuses a file that has more than one name', async () => {
    const { root, workspace } = await sandbox();
    try {
      await writeFile(join(workspace, 'real.txt'), 'contents');
      await link(join(workspace, 'real.txt'), join(workspace, 'alias.txt'));

      await expect(readWorkspaceFile(workspace, 'alias.txt', 4096)).rejects.toThrow(
        /single-link/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses something that is not a regular file', async () => {
    const { root, workspace } = await sandbox();
    try {
      await mkdir(join(workspace, 'adirectory'));

      await expect(readWorkspaceFile(workspace, 'adirectory', 4096)).rejects.toThrow(
        /regular single-link file/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a file past the limit rather than returning a prefix of it', async () => {
    const { root, workspace } = await sandbox();
    try {
      await writeFile(join(workspace, 'big.txt'), 'x'.repeat(500));

      await expect(readWorkspaceFile(workspace, 'big.txt', 100)).rejects.toThrow(/size limit/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ordinary filesystem work still works', () => {
  it('creates intermediate directories, reads back, and reports a missing file as null', async () => {
    const { root, workspace } = await sandbox();
    try {
      expect(await readWorkspaceFile(workspace, 'src/deep/file.ts', 4096)).toBeNull();

      await writeWorkspaceFile(
        workspace,
        'src/deep/file.ts',
        Buffer.from('export const a = 1;\n'),
        () => null,
        4096,
      );

      expect((await readWorkspaceFile(workspace, 'src/deep/file.ts', 4096))?.toString()).toBe(
        'export const a = 1;\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('truncates when the new content is shorter, leaving no tail behind', async () => {
    const { root, workspace } = await sandbox();
    try {
      await writeWorkspaceFile(workspace, 'a.txt', Buffer.from('a long original line'), () => null, 4096);
      await writeWorkspaceFile(workspace, 'a.txt', Buffer.from('short'), () => null, 4096);

      expect((await readWorkspaceFile(workspace, 'a.txt', 4096))?.toString()).toBe('short');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets the decision refuse the write, and then nothing is written', async () => {
    const { root, workspace } = await sandbox();
    try {
      await writeWorkspaceFile(workspace, 'a.txt', Buffer.from('original'), () => null, 4096);

      const refusal = await writeWorkspaceFile(
        workspace,
        'a.txt',
        Buffer.from('replacement'),
        (current) => (current?.toString() === 'original' ? 'refused' : null),
        4096,
      );

      expect(refusal).toBe('refused');
      expect((await readWorkspaceFile(workspace, 'a.txt', 4096))?.toString()).toBe('original');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats deleting something that is not there as done, not as a failure', async () => {
    const { root, workspace } = await sandbox();
    try {
      await expect(deleteWorkspaceFile(workspace, 'never/existed.txt')).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the sync path, which is where this actually runs', () => {
  it('writes, reads back, and deletes an editor change', async () => {
    const { root, workspace } = await sandbox();
    const index = new SyncIndex();
    try {
      const written = await applyEditorWrite(
        workspace,
        index,
        { path: 'src/main.ts', content: 'const a = 1;\n' },
        limits,
      );
      expect(written.status).toBe('written');
      expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('const a = 1;\n');

      const manifest = await containerManifest(workspace, ['src/main.ts'], limits);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].size).toBe('const a = 1;\n'.length);

      const deleted = await applyEditorDelete(workspace, index, 'src/main.ts');
      expect(deleted.status).toBe('written');
      expect(await readFile(join(workspace, 'src/main.ts'), 'utf8').catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still refuses a concurrent change as a conflict rather than overwriting it', async () => {
    const { root, workspace } = await sandbox();
    const index = new SyncIndex();
    try {
      await writeFile(join(workspace, 'notes.txt'), 'the container wrote this');

      const outcome = await applyEditorWrite(
        workspace,
        index,
        { path: 'notes.txt', content: 'the editor wrote this', baseHash: 'something-else' },
        limits,
      );

      expect(outcome.status).toBe('conflict');
      expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('the container wrote this');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The path-validation defenses are still in front, and still decide first. */
  it('still refuses a protected path before reaching the filesystem at all', async () => {
    const { root, workspace } = await sandbox();
    const index = new SyncIndex();
    try {
      const outcome = await applyEditorWrite(
        workspace,
        index,
        { path: '.env', content: 'SECRET=1' },
        limits,
      );

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'protected path' });
      expect(await readFile(join(workspace, '.env'), 'utf8').catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still refuses a path that escapes the workspace', async () => {
    const { root, workspace } = await sandbox();
    const index = new SyncIndex();
    try {
      await expect(
        applyEditorWrite(workspace, index, { path: '../outside/secret.txt', content: 'x' }, limits),
      ).rejects.toThrow();
      expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('must not be touched');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A second name for the same inode. The path walk sees an ordinary file at an
   * ordinary path, so this is only refusable at the descriptor — and refusing
   * it is what stops a name inside the workspace being used to reach a file the
   * path checks were never asked about.
   */
  it('does not send a container change for a file that has a second name', async () => {
    const { root, workspace } = await sandbox();
    const index = new SyncIndex();
    try {
      await writeFile(join(workspace, 'real.txt'), 'contents');
      await link(join(workspace, 'real.txt'), join(workspace, 'alias.txt'));

      expect(await readContainerChange(workspace, index, 'alias.txt', limits)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not read a container change out through a symlinked directory', async () => {
    const { root, workspace, outside } = await sandbox();
    const index = new SyncIndex();
    try {
      await symlink(outside, join(workspace, 'linked'));

      expect(await readContainerChange(workspace, index, 'linked/secret.txt', limits)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the transfer path', () => {
  async function twoWorkspaces() {
    const root = await mkdtemp(join(tmpdir(), 'tacode-xfer-secure-'));
    const projectDir = join(root, 'project');
    const linuxDir = join(root, 'linux');
    const outside = join(root, 'outside');
    await mkdir(projectDir, { recursive: true });
    await mkdir(linuxDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'must not be touched');

    return {
      root,
      projectDir,
      linuxDir,
      outside,
      project: workspaceRecord({ id: 'tacode-p', workspaceDir: projectDir }),
      linux: workspaceRecord({
        id: 'tacode-l',
        kind: 'linux',
        projectId: null,
        workspaceDir: linuxDir,
      }),
    };
  }

  it('still copies a real file between two workspaces', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'notes.txt'), 'carry me across');

      const outcome = await transferFiles(project, linux, ['notes.txt']);

      expect(outcome.copied).toEqual(['notes.txt']);
      expect(await readFile(join(linuxDir, 'notes.txt'), 'utf8')).toBe('carry me across');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still reports a conflict instead of overwriting when not told to', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'notes.txt'), 'from the project');
      await writeFile(join(linuxDir, 'notes.txt'), 'already here');

      const outcome = await transferFiles(project, linux, ['notes.txt']);

      expect(outcome.conflicts).toEqual(['notes.txt']);
      expect(await readFile(join(linuxDir, 'notes.txt'), 'utf8')).toBe('already here');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites when it is told to', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'notes.txt'), 'from the project');
      await writeFile(join(linuxDir, 'notes.txt'), 'already here');

      const outcome = await transferFiles(project, linux, ['notes.txt'], { overwrite: true });

      expect(outcome.copied).toEqual(['notes.txt']);
      expect(await readFile(join(linuxDir, 'notes.txt'), 'utf8')).toBe('from the project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not carry a file out through a symlinked directory in the source', async () => {
    const { root, projectDir, linuxDir, outside, project, linux } = await twoWorkspaces();
    try {
      await symlink(outside, join(projectDir, 'linked'));

      const outcome = await transferFiles(project, linux, ['linked/secret.txt']);

      expect(outcome.copied).toEqual([]);
      expect(
        await readFile(join(linuxDir, 'linked/secret.txt'), 'utf8').catch(() => null),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not carry a file that has a second name inside the workspace', async () => {
    const { root, projectDir, linuxDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, 'real.txt'), 'contents');
      await link(join(projectDir, 'real.txt'), join(projectDir, 'alias.txt'));

      const outcome = await transferFiles(project, linux, ['alias.txt']);

      expect(outcome.copied).toEqual([]);
      expect(await readFile(join(linuxDir, 'alias.txt'), 'utf8').catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still refuses a protected path', async () => {
    const { root, projectDir, project, linux } = await twoWorkspaces();
    try {
      await writeFile(join(projectDir, '.env'), 'SECRET=1');

      const outcome = await transferFiles(project, linux, ['.env']);

      expect(outcome.copied).toEqual([]);
      expect(outcome.skipped).toEqual([{ path: '.env', reason: 'protected path' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a directory as not a file, rather than failing the whole transfer', async () => {
    const { root, projectDir, project, linux } = await twoWorkspaces();
    try {
      await mkdir(join(projectDir, 'folder'));

      const outcome = await transferFiles(project, linux, ['folder']);

      expect(outcome.copied).toEqual([]);
      expect(outcome.skipped).toEqual([{ path: 'folder', reason: 'not a file' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
