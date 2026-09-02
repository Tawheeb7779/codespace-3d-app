import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore, validateProjectName } from '@/stores/projectStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useGitStore } from '@/stores/gitStore';
import type { AuthUser } from '@/types';

/**
 * Store-level tests run against the local repository. jsdom has no IndexedDB,
 * so `lib/idb` transparently falls back to its in-memory map — exercising the
 * same degraded path a locked-down browser would take.
 */

const user: AuthUser = {
  id: 'user-1',
  email: 'dev@example.com',
  displayName: 'Dev',
  avatarUrl: null,
  provider: 'local',
};

async function freshProject(name = 'Demo') {
  const project = await useProjectStore.getState().create({ name, template: 'vanilla' });
  await useFileStore.getState().open(project.id);
  return project;
}

beforeEach(async () => {
  useAuthStore.setState({ user, status: 'authenticated', localMode: true });
  useProjectStore.setState({ projects: [], loading: false, error: null });
  await useFileStore.getState().close();
  useEditorStore.setState({ tabs: [], activePath: null, problems: [], splitPath: null });
});

describe('project lifecycle', () => {
  it('validates names', () => {
    expect(validateProjectName('  My   App ')).toBe('My App');
    expect(() => validateProjectName('   ')).toThrow(/cannot be empty/);
    expect(() => validateProjectName('x'.repeat(61))).toThrow(/60 characters/);
  });

  it('creates a project from a template and lists it', async () => {
    const project = await freshProject('Landing');
    expect(project.files['index.html']).toContain('<!doctype html>');
    expect(useProjectStore.getState().projects.map((p) => p.id)).toContain(project.id);
  });

  it('assigns the signed-in user as owner and grants write access', async () => {
    const project = await freshProject();
    expect(project.ownerId).toBe(user.id);
    expect(useFileStore.getState().role).toBe('owner');
    expect(useFileStore.getState().canWrite()).toBe(true);
  });

  it('renames, stars and duplicates', async () => {
    const project = await freshProject('Original');
    const store = useProjectStore.getState();

    await store.rename(project.id, 'Renamed');
    expect(useProjectStore.getState().projects.find((p) => p.id === project.id)?.name).toBe('Renamed');

    await store.toggleStar(project.id);
    expect(useProjectStore.getState().projects.find((p) => p.id === project.id)?.starred).toBe(true);

    const copy = await store.duplicate(project.id);
    expect(copy.name).toBe('Renamed copy');
    expect(copy.files).toEqual(project.files);
    expect(copy.id).not.toBe(project.id);
  });

  it('deletes a project and drops it from the list', async () => {
    const project = await freshProject();
    await useProjectStore.getState().remove(project.id);
    expect(useProjectStore.getState().projects.find((p) => p.id === project.id)).toBeUndefined();
  });

  it('reports a project that no longer exists', async () => {
    await expect(useFileStore.getState().open('missing')).rejects.toThrow(/does not exist/);
  });
});

describe('file operations', () => {
  it('creates files and marks them dirty until flushed', async () => {
    await freshProject();
    const store = useFileStore.getState();
    store.createFile('src/new.ts', 'export const x = 1;');
    expect(useFileStore.getState().files['src/new.ts']).toBe('export const x = 1;');
    expect(useFileStore.getState().dirty.has('src/new.ts')).toBe(true);

    await useFileStore.getState().flush();
    expect(useFileStore.getState().dirty.size).toBe(0);
  });

  it('persists across a close and reopen', async () => {
    const project = await freshProject();
    useFileStore.getState().createFile('src/keep.ts', 'kept');
    await useFileStore.getState().flush();
    await useFileStore.getState().close();

    await useFileStore.getState().open(project.id);
    expect(useFileStore.getState().files['src/keep.ts']).toBe('kept');
  });

  it('refuses duplicate and traversing paths', async () => {
    await freshProject();
    const store = useFileStore.getState();
    store.createFile('src/dup.ts', '');
    expect(() => useFileStore.getState().createFile('src/dup.ts', '')).toThrow(/already exists/);
    expect(() => useFileStore.getState().createFile('../escape.ts', '')).toThrow(
      /escapes the project root/,
    );
    expect(() => useFileStore.getState().createFile('.env', 'SECRET=1')).toThrow(/protected path/);
  });

  it('renames a folder and every descendant', async () => {
    await freshProject();
    const store = useFileStore.getState();
    store.createFile('lib/a.ts', 'a');
    useFileStore.getState().createFile('lib/nested/b.ts', 'b');

    useFileStore.getState().rename('lib', 'library');
    const files = useFileStore.getState().files;
    expect(files['library/a.ts']).toBe('a');
    expect(files['library/nested/b.ts']).toBe('b');
    expect(files['lib/a.ts']).toBeUndefined();
  });

  it('deletes a folder recursively', async () => {
    await freshProject();
    useFileStore.getState().createFile('tmp/a.ts', 'a');
    useFileStore.getState().createFile('tmp/deep/b.ts', 'b');
    useFileStore.getState().remove('tmp');
    const files = useFileStore.getState().files;
    expect(Object.keys(files).some((path) => path.startsWith('tmp'))).toBe(false);
  });

  it('duplicates a file with a non-colliding name', async () => {
    await freshProject();
    useFileStore.getState().createFile('src/a.ts', 'body');
    const copy = useFileStore.getState().duplicate('src/a.ts');
    expect(copy).toBe('src/a copy.ts');
    expect(useFileStore.getState().files[copy]).toBe('body');
  });

  it('moves a file into another folder', async () => {
    await freshProject();
    useFileStore.getState().createFile('a.ts', 'x');
    const moved = useFileStore.getState().move('a.ts', 'src');
    expect(moved).toBe('src/a.ts');
    expect(useFileStore.getState().files['src/a.ts']).toBe('x');
  });

  // The client mirror of what row level security enforces server side.
  it('blocks every mutation for a read-only role', async () => {
    await freshProject();
    useFileStore.setState({ role: 'viewer' });
    const store = useFileStore.getState();
    expect(store.canWrite()).toBe(false);
    expect(() => store.writeFile('src/a.ts', 'x')).toThrow(/read-only/);
    expect(() => store.createFile('src/b.ts', 'x')).toThrow(/read-only/);
    expect(() => store.remove('index.html')).toThrow(/read-only/);
    expect(() => store.rename('index.html', 'other.html')).toThrow(/read-only/);
  });
});

describe('editor tabs', () => {
  it('opens each path once and tracks the active tab', () => {
    const store = useEditorStore.getState();
    store.openTab('a.ts');
    store.openTab('b.ts');
    store.openTab('a.ts');
    expect(useEditorStore.getState().tabs.map((t) => t.path)).toEqual(['a.ts', 'b.ts']);
    expect(useEditorStore.getState().activePath).toBe('a.ts');
  });

  it('focuses the neighbouring tab when the active one closes', () => {
    const store = useEditorStore.getState();
    ['a.ts', 'b.ts', 'c.ts'].forEach((path) => store.openTab(path));
    useEditorStore.getState().setActive('b.ts');
    useEditorStore.getState().closeTab('b.ts');
    expect(useEditorStore.getState().activePath).toBe('a.ts');
  });

  it('rewrites tab paths on a folder rename', () => {
    const store = useEditorStore.getState();
    store.openTab('lib/a.ts');
    useEditorStore.getState().renamePath('lib', 'library');
    expect(useEditorStore.getState().tabs[0].path).toBe('library/a.ts');
    expect(useEditorStore.getState().activePath).toBe('library/a.ts');
  });

  it('closes every tab under a deleted folder', () => {
    const store = useEditorStore.getState();
    store.openTab('lib/a.ts');
    useEditorStore.getState().openTab('lib/b.ts');
    useEditorStore.getState().openTab('other.ts');
    useEditorStore.getState().removePath('lib');
    expect(useEditorStore.getState().tabs.map((t) => t.path)).toEqual(['other.ts']);
  });

  it('keeps pinned tabs when closing others', () => {
    const store = useEditorStore.getState();
    ['a.ts', 'b.ts', 'c.ts'].forEach((path) => store.openTab(path));
    useEditorStore.getState().togglePin('c.ts');
    useEditorStore.getState().closeOthers('a.ts');
    expect(useEditorStore.getState().tabs.map((t) => t.path).sort()).toEqual(['a.ts', 'c.ts']);
  });
});

describe('version control integration', () => {
  it('commits the working tree and reports a clean status', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    await useGitStore.getState().stage();
    const commit = await useGitStore.getState().commit('initial import');

    expect(commit.message).toBe('initial import');
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.clean).toBe(true);
    expect(useGitStore.getState().history).toHaveLength(1);
  });

  it('detects a working-tree edit after a commit', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('base');

    useFileStore.getState().writeFile('index.html', '<!doctype html><title>changed</title>');
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.unstaged.map((c) => c.path)).toEqual(['index.html']);
  });

  it('runs git commands through the shell surface', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    const before = await useGitStore.getState().runCommand(['status']);
    expect(before.map((l) => l.text).join('\n')).toContain('not a Forge VCS repository');

    await useGitStore.getState().runCommand(['init']);
    const after = await useGitStore.getState().runCommand(['status']);
    expect(after.map((l) => l.text).join('\n')).toContain('On branch main');
  });

  it('refuses network git operations with an explanation', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    const lines = await useGitStore.getState().runCommand(['push']);
    expect(lines.some((l) => l.kind === 'stderr')).toBe(true);
    expect(lines.map((l) => l.text).join(' ')).toContain('not available');
  });
});
