import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore } from '@/stores/projectStore';
import { useFileStore } from '@/stores/fileStore';
import { localRepository } from '@/lib/repo/localRepository';
import type { AuthUser } from '@/types';

/**
 * Persistence, which is the part of an editor that is allowed to be boring and
 * is never allowed to be wrong.
 *
 * Two failures motivated these: a newly created empty folder was never written
 * at all, because the save short-circuits on an empty dirty set; and a save
 * that completed while the user kept typing marked the newer edits clean, so
 * they were dropped on the next reload with nothing reported.
 */

const user: AuthUser = {
  id: 'user-persist',
  email: 'dev@example.com',
  displayName: 'Dev',
  avatarUrl: null,
  provider: 'local',
};

async function openProject() {
  const project = await useProjectStore.getState().create({ name: 'Persist', template: 'vanilla' });
  await useFileStore.getState().open(project.id);
  return project;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user, status: 'authenticated', localMode: true });
  useProjectStore.setState({ projects: [], loading: false, error: null });
  await useFileStore.getState().close();
});

describe('directories', () => {
  it('writes an empty directory, so it is still there after a reload', async () => {
    const project = await openProject();
    useFileStore.getState().createDir('src/empty');
    await useFileStore.getState().flush();

    const stored = await localRepository.getProject(project.id);
    expect(stored?.dirs).toContain('src/empty');
  });

  it('writes a renamed directory that holds no files', async () => {
    const project = await openProject();
    useFileStore.getState().createDir('docs');
    await useFileStore.getState().flush();
    useFileStore.getState().rename('docs', 'guides');
    await useFileStore.getState().flush();

    const stored = await localRepository.getProject(project.id);
    expect(stored?.dirs).toContain('guides');
    expect(stored?.dirs).not.toContain('docs');
  });
});

describe('saving while the user keeps typing', () => {
  it('does not mark an edit clean that the save never carried', async () => {
    const project = await openProject();
    const file = useFileStore.getState().createFile('notes.txt', 'first');

    // Type while the write is in flight — after the tree it carries has
    // already been snapshotted. This is the race, reproduced exactly.
    const real = localRepository.saveFiles.bind(localRepository);
    const spy = vi
      .spyOn(localRepository, 'saveFiles')
      .mockImplementationOnce(async (id, files, dirs, changed) => {
        useFileStore.getState().writeFile(file, 'second');
        await real(id, files, dirs, changed);
      });

    await useFileStore.getState().flush();
    spy.mockRestore();

    // The write carried "first"; "second" arrived after the snapshot and is
    // still unsaved, so it must still be dirty.
    expect(useFileStore.getState().dirty.has(file)).toBe(true);

    await useFileStore.getState().flush();
    expect(useFileStore.getState().dirty.has(file)).toBe(false);
    const stored = await localRepository.getProject(project.id);
    expect(stored?.files[file]).toBe('second');
  });

  it('serialises overlapping saves so the newer tree wins', async () => {
    const project = await openProject();
    const file = useFileStore.getState().createFile('order.txt', 'one');

    const real = localRepository.saveFiles.bind(localRepository);
    const order: string[] = [];
    let second: Promise<void> | undefined;
    const spy = vi
      .spyOn(localRepository, 'saveFiles')
      .mockImplementation(async (id, files, dirs, changed) => {
        order.push(String(files[file]));
        if (order.length === 1) {
          // A second save is asked for while the first is still writing. If it
          // were allowed to start now it would finish first, and the slow
          // write below would then put the older tree back.
          useFileStore.getState().writeFile(file, 'two');
          second = useFileStore.getState().flush();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await real(id, files, dirs, changed);
      });

    await useFileStore.getState().flush();
    await second;
    spy.mockRestore();

    expect(order).toEqual(['one', 'two']);
    const stored = await localRepository.getProject(project.id);
    expect(stored?.files[file]).toBe('two');
  });

  it('keeps work dirty when the backend rejects, and still saves the next time', async () => {
    const project = await openProject();
    const file = useFileStore.getState().createFile('retry.txt', 'draft');

    const spy = vi
      .spyOn(localRepository, 'saveFiles')
      .mockRejectedValueOnce(new Error('backend is down'));

    await expect(useFileStore.getState().flush()).rejects.toThrow(/backend is down/);
    expect(useFileStore.getState().dirty.has(file)).toBe(true);
    expect(useFileStore.getState().error).toMatch(/backend is down/);
    spy.mockRestore();

    // A failed save must not poison the queue behind it.
    await useFileStore.getState().flush();
    const stored = await localRepository.getProject(project.id);
    expect(stored?.files[file]).toBe('draft');
  });
});
