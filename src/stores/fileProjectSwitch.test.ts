import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opening a second project before the first has finished loading.
 *
 * `open` reads a project and then puts it in the store. Two opens can be in
 * flight at once — clicking one project on the dashboard and then another, or a
 * back-navigation — and whichever answer arrived last used to win, regardless
 * of which project the workspace is actually showing.
 *
 * That is the working tree, so a stale answer landing is worse than a wrong
 * display: `flush` writes `files` to `projectId`, and both come from this
 * store, so a project loaded into the wrong slot is a project about to be
 * written over. The load now only lands if it is still the one being awaited.
 */

const getProject = vi.fn<(id: string) => Promise<unknown>>();
const roleFor = vi.fn().mockResolvedValue('owner');

vi.mock('@/lib/repo', () => ({
  repositoryFor: () => ({ getProject, roleFor, saveFiles: vi.fn() }),
}));

const { useFileStore } = await import('@/stores/fileStore');
const { useAuthStore } = await import('@/stores/authStore');

/** `open` reaches the repository several microtasks in, through `flush`. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const project = (id: string) => ({
  id,
  ownerId: 'me',
  name: id,
  description: '',
  template: 'vanilla',
  language: 'HTML',
  visibility: 'private',
  status: 'active',
  starred: false,
  createdAt: 1,
  updatedAt: 2,
  files: { [`${id}.txt`]: id },
  dirs: [],
});

beforeEach(() => {
  getProject.mockReset();
  useAuthStore.setState({ user: { id: 'me', email: 'me@example.com', displayName: 'Me' } as never });
  useFileStore.setState({
    projectId: null,
    meta: null,
    files: {},
    dirs: [],
    dirty: new Set(),
    loading: false,
    error: null,
  });
});

describe('two opens in flight', () => {
  it('keeps the project that was asked for last', async () => {
    const answers: Record<string, () => void> = {};
    getProject.mockImplementation(
      (id) =>
        new Promise((resolve) => {
          answers[id] = () => resolve(project(id));
        }),
    );

    const first = useFileStore.getState().open('a');
    await settle();
    const second = useFileStore.getState().open('b');
    await settle();

    // B answers, then the abandoned A answer arrives.
    answers.b();
    await second;
    answers.a();
    await first.catch(() => undefined);

    expect(useFileStore.getState().projectId).toBe('b');
    expect(Object.keys(useFileStore.getState().files)).toEqual(['b.txt']);
  });

  it('does not leave the workspace stuck loading, or showing a stale error', async () => {
    getProject.mockImplementation((id) =>
      id === 'a' ? Promise.reject(new Error('a is gone')) : Promise.resolve(project(id)),
    );

    const first = useFileStore.getState().open('a').catch(() => undefined);
    const second = useFileStore.getState().open('b');
    await Promise.all([first, second]);

    expect(useFileStore.getState().projectId).toBe('b');
    expect(useFileStore.getState().loading).toBe(false);
    expect(useFileStore.getState().error).toBeNull();
  });
});

describe('the ordinary case', () => {
  it('opens the project and reports no error', async () => {
    getProject.mockResolvedValue(project('a'));

    await useFileStore.getState().open('a');

    expect(useFileStore.getState().projectId).toBe('a');
    expect(useFileStore.getState().loading).toBe(false);
    expect(useFileStore.getState().error).toBeNull();
  });

  it('reports a failure for the project it was asked to open', async () => {
    getProject.mockRejectedValue(new Error('no such project'));

    await expect(useFileStore.getState().open('a')).rejects.toThrow('no such project');
    expect(useFileStore.getState().error).toBe('no such project');
    expect(useFileStore.getState().loading).toBe(false);
  });
});
