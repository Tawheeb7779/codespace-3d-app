import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore, validateProjectName } from '@/stores/projectStore';
import { useFileStore } from '@/stores/fileStore';
import { splitTargetFor, useEditorStore } from '@/stores/editorStore';
import { useUIStore } from '@/stores/uiStore';
import { DEFAULT_KEYBINDINGS } from '@/stores/settingsStore';
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

  /**
   * Creating and renaming both refuse a protected path. A plain write has to
   * as well, or a project-wide replace becomes a way to author into `.env`.
   */
  it('refuses to write a protected path, not just to create one', async () => {
    await freshProject();
    for (const path of ['.env', '.git/config', '.npmrc', 'node_modules/x/index.js']) {
      expect(() => useFileStore.getState().writeFile(path, 'SECRET=1'), path).toThrow(
        /protected path/,
      );
      expect(useFileStore.getState().files, path).not.toHaveProperty(path);
    }
    // An ordinary file is unaffected.
    useFileStore.getState().createFile('src/ok.ts', 'a');
    useFileStore.getState().writeFile('src/ok.ts', 'b');
    expect(useFileStore.getState().files['src/ok.ts']).toBe('b');
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

  /**
   * The side pane renders a file it can name, so a split target equal to the
   * active file left the button lit with nothing beside it — a dead control.
   */
  describe('splitTargetFor', () => {
    const tabs = (...paths: string[]) => paths.map((path) => ({ path, pinned: false }));

    it('splits to the next tab', () => {
      expect(splitTargetFor(tabs('a.ts', 'b.ts', 'c.ts'), 'a.ts')).toBe('b.ts');
    });

    it('falls back to the previous tab for the last one', () => {
      expect(splitTargetFor(tabs('a.ts', 'b.ts'), 'b.ts')).toBe('a.ts');
    });

    it('splits the active file when it is the only tab', () => {
      expect(splitTargetFor(tabs('a.ts'), 'a.ts')).toBe('a.ts');
    });

    it('has nothing to split with no tabs', () => {
      expect(splitTargetFor([], null)).toBeNull();
    });

    it('picks the first tab when the active path is not among them', () => {
      expect(splitTargetFor(tabs('a.ts', 'b.ts'), 'gone.ts')).toBe('a.ts');
    });
  });
});

describe('keybindings', () => {
  it('binds every command to a distinct chord', () => {
    const chords = DEFAULT_KEYBINDINGS.map((binding) => binding.keys);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('gives every binding a distinct id', () => {
    const ids = DEFAULT_KEYBINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bottom panel', () => {
  /**
   * `setBottomTab` opens the panel as a side effect. Chaining it with an
   * unconditional toggle always landed on closed, so the shortcut could hide
   * the panel but never bring it back.
   */
  it('opens the panel whenever a tab is selected', () => {
    useUIStore.getState().toggleBottom(false);
    useUIStore.getState().setBottomTab('terminal');
    expect(useUIStore.getState().bottomOpen).toBe(true);
    expect(useUIStore.getState().bottomTab).toBe('terminal');
  });

  it('closes on an explicit false and reopens on an explicit true', () => {
    useUIStore.getState().toggleBottom(false);
    expect(useUIStore.getState().bottomOpen).toBe(false);
    useUIStore.getState().toggleBottom(true);
    expect(useUIStore.getState().bottomOpen).toBe(true);
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

  it('branches, diverges and merges cleanly through the store', async () => {
    const project = await freshProject();
    const git = useGitStore.getState();
    const files = useFileStore.getState();
    await git.load(project.id);
    await git.init();
    await git.stage();
    await git.commit('base');

    // A feature branch edits one file…
    await useGitStore.getState().createBranch('feature', true);
    files.writeFile('src/main.js', '// feature edit\n');
    await files.flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('feature edit');

    // …while main edits a different one.
    await useGitStore.getState().checkout('main');
    expect(useFileStore.getState().files['src/main.js']).not.toContain('feature edit');
    useFileStore.getState().writeFile('README.md', '# main edit\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('main edit');

    const outcome = await useGitStore.getState().merge('feature');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.upToDate).toBe(false);
    expect(useFileStore.getState().files['src/main.js']).toContain('feature edit');
    expect(useFileStore.getState().files['README.md']).toContain('main edit');
    expect(useGitStore.getState().status.clean).toBe(true);
  });

  it('writes conflict markers and lets the user resolve and commit', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    useFileStore.getState().writeFile('conflict.txt', 'line1\nshared\nline3\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('base');

    await useGitStore.getState().createBranch('theirs', true);
    useFileStore.getState().writeFile('conflict.txt', 'line1\nTHEIRS\nline3\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('theirs edit');

    await useGitStore.getState().checkout('main');
    useFileStore.getState().writeFile('conflict.txt', 'line1\nOURS\nline3\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('ours edit');

    const outcome = await useGitStore.getState().merge('theirs');
    expect(outcome.conflicts).toEqual(['conflict.txt']);

    // The conflict is written into the working tree for the user to resolve.
    const conflicted = useFileStore.getState().files['conflict.txt'];
    expect(conflicted).toContain('<<<<<<< ours');
    expect(conflicted).toContain('OURS');
    expect(conflicted).toContain('=======');
    expect(conflicted).toContain('THEIRS');
    expect(conflicted).toContain('>>>>>>> theirs');

    // No merge commit was created while the conflict stands.
    expect(useGitStore.getState().history[0].message).toBe('ours edit');
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.clean).toBe(false);

    // Resolving is an ordinary edit, stage, commit.
    useFileStore.getState().writeFile('conflict.txt', 'line1\nRESOLVED\nline3\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    const resolved = await useGitStore.getState().commit('resolve conflict');
    expect(resolved.message).toBe('resolve conflict');
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.clean).toBe(true);
    expect(useFileStore.getState().files['conflict.txt']).not.toContain('<<<<<<<');
  });

  it('abandons a conflicted merge by discarding the working tree', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    useFileStore.getState().writeFile('c.txt', 'base\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('base');

    await useGitStore.getState().createBranch('side', true);
    useFileStore.getState().writeFile('c.txt', 'side\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('side');

    await useGitStore.getState().checkout('main');
    useFileStore.getState().writeFile('c.txt', 'main\n');
    await useFileStore.getState().flush();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('main');

    const outcome = await useGitStore.getState().merge('side');
    expect(outcome.conflicts).toEqual(['c.txt']);

    // Discard restores from the index, which still holds the pre-merge commit.
    await useGitStore.getState().discard(['c.txt']);
    expect(useFileStore.getState().files['c.txt']).toBe('main\n');
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.clean).toBe(true);
  });

  it('stages and unstages individual paths', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('base');

    useFileStore.getState().writeFile('src/main.js', '// one\n');
    useFileStore.getState().writeFile('README.md', '# two\n');
    await useFileStore.getState().flush();
    useGitStore.getState().refresh();
    expect(useGitStore.getState().status.unstaged).toHaveLength(2);

    await useGitStore.getState().stage(['src/main.js']);
    expect(useGitStore.getState().status.staged.map((c) => c.path)).toEqual(['src/main.js']);
    expect(useGitStore.getState().status.unstaged.map((c) => c.path)).toEqual(['README.md']);

    await useGitStore.getState().unstage(['src/main.js']);
    expect(useGitStore.getState().status.staged).toHaveLength(0);
    expect(useGitStore.getState().status.unstaged).toHaveLength(2);
  });

  it('refuses to switch branches with uncommitted work', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    await useGitStore.getState().stage();
    await useGitStore.getState().commit('base');
    await useGitStore.getState().createBranch('other', false);

    useFileStore.getState().writeFile('README.md', 'dirty\n');
    await useFileStore.getState().flush();
    await expect(useGitStore.getState().checkout('other')).rejects.toThrow(/uncommitted changes/);
  });

  it('refuses a push with no remote, and says how to get one', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    const lines = await useGitStore.getState().runCommand(['push']);
    expect(lines.some((l) => l.kind === 'stderr')).toBe(true);
    const text = lines.map((l) => l.text).join(' ');
    expect(text).toContain('no remote configured');
    expect(text).toMatch(/Source Control/);
  });

  it('still refuses clone, which has no in-browser equivalent', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    const lines = await useGitStore.getState().runCommand(['clone']);
    expect(lines.map((l) => l.text).join(' ')).toContain('not available');
  });

  it('reports no remote until one is connected', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    expect(useGitStore.getState().remote).toBeNull();
    expect(useGitStore.getState().sync().state).toBe('unlinked');
    const lines = await useGitStore.getState().runCommand(['remote']);
    expect(lines.map((l) => l.text).join(' ')).toContain('No remote configured');
  });

  it('connects a repository, persists it, and reloads it with the project', async () => {
    const project = await freshProject();
    await useGitStore.getState().load(project.id);
    await useGitStore.getState().init();
    await useGitStore.getState().connectRemote({
      id: 42,
      owner: 'octocat',
      name: 'demo',
      fullName: 'octocat/demo',
      private: false,
      defaultBranch: 'main',
      description: '',
      updatedAt: '',
      canPush: true,
      empty: false,
    });
    expect(useGitStore.getState().remote?.repo).toBe('demo');
    expect(useGitStore.getState().sync().state).toBe('never-fetched');

    await useGitStore.getState().load(project.id);
    expect(useGitStore.getState().remote?.owner).toBe('octocat');
    expect(useGitStore.getState().remote?.branch).toBe('main');

    const lines = await useGitStore.getState().runCommand(['remote']);
    expect(lines.map((l) => l.text).join(' ')).toContain('octocat/demo');

    await useGitStore.getState().disconnectRemote();
    expect(useGitStore.getState().remote).toBeNull();
    await useGitStore.getState().load(project.id);
    expect(useGitStore.getState().remote).toBeNull();
  });
});
