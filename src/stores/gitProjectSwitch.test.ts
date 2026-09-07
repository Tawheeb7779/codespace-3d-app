import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vcs from '@/lib/vcs';

/**
 * A repository loaded for one project must not land in another.
 *
 * `gitStore.load` reads the version history for a project id, and the read is
 * asynchronous. Opening one project and then another before the first answer
 * arrives left the older project's repository in the store — while the file
 * store already held the newer project's files.
 *
 * That is not only a wrong display. Everything that persists version history
 * writes to `useFileStore.getState().projectId`, the project that is *open*, so
 * the next commit would have written the first project's history onto the
 * second one. The other stores that load per project already guard for this;
 * this one did not.
 */

const loadVcs = vi.fn<(id: string) => Promise<unknown>>();
const loadRemote = vi.fn<(id: string) => Promise<unknown>>();

vi.mock('@/lib/repo', () => ({
  repositoryFor: () => ({ loadVcs, loadRemote, saveVcs: vi.fn(), saveRemote: vi.fn() }),
}));

const { useGitStore } = await import('@/stores/gitStore');
const { useFileStore } = await import('@/stores/fileStore');

/** A real initialised repository, named so which one landed is visible. */
const repoNamed = (branch: string) => vcs.initRepo(branch);

beforeEach(() => {
  loadVcs.mockReset();
  loadRemote.mockReset();
  loadRemote.mockResolvedValue(null);
  useFileStore.setState({ projectId: null, files: {} });
  useGitStore.setState({ repo: vcs.emptyRepo(), loading: false, error: null });
});

describe('opening a second project before the first has answered', () => {
  it('keeps the repository of the project that is actually open', async () => {
    const answers: Record<string, () => void> = {};
    loadVcs.mockImplementation(
      (id) =>
        new Promise((resolve) => {
          answers[id] = () => resolve(repoNamed(`branch-of-${id}`));
        }),
    );

    // Project A is opened, then B before A's history comes back.
    const first = useGitStore.getState().load('project-a');
    await Promise.resolve();
    useFileStore.setState({ projectId: 'project-b' });
    const second = useGitStore.getState().load('project-b');
    await Promise.resolve();

    // B answers first, then the stale A answer arrives.
    answers['project-b']();
    await second;
    answers['project-a']();
    await first;

    expect(useGitStore.getState().repo.head).toBe('branch-of-project-b');
  });

  it('does not report the stale project\'s failure over the open one', async () => {
    let failA: (error: Error) => void = () => {};
    loadVcs.mockImplementation((id) =>
      id === 'project-a'
        ? new Promise((_resolve, reject) => {
            failA = reject;
          })
        : Promise.resolve(repoNamed('branch-of-project-b')),
    );

    const first = useGitStore.getState().load('project-a');
    await Promise.resolve();
    useFileStore.setState({ projectId: 'project-b' });
    await useGitStore.getState().load('project-b');

    failA(new Error('project A is gone'));
    await first.catch(() => undefined);

    expect(useGitStore.getState().error).toBeNull();
    expect(useGitStore.getState().loading).toBe(false);
    expect(useGitStore.getState().repo.head).toBe('branch-of-project-b');
  });
});

describe('the ordinary case', () => {
  it('loads the repository for the project that was opened', async () => {
    loadVcs.mockResolvedValue(repoNamed('main'));
    useFileStore.setState({ projectId: 'project-a' });

    await useGitStore.getState().load('project-a');

    expect(useGitStore.getState().repo.head).toBe('main');
    expect(useGitStore.getState().loading).toBe(false);
  });

  it('reports a failure for the project that is open', async () => {
    loadVcs.mockRejectedValue(new Error('history unreadable'));
    useFileStore.setState({ projectId: 'project-a' });

    await useGitStore.getState().load('project-a');

    expect(useGitStore.getState().error).toBe('history unreadable');
    expect(useGitStore.getState().loading).toBe(false);
  });
});
