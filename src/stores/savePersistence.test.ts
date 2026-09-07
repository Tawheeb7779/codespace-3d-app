import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A save that failed has to be visible.
 *
 * The reported failure was: create a file, let it save, refresh, and the file
 * is gone — with nothing on screen ever having said a save failed. The cause
 * was where the reporting lived. Auto-save is on by default, so most saves are
 * ones nobody asked for and nobody awaits: `scheduleSave` and the visibility
 * handler both absorbed the rejection, and only the explicit Ctrl+S path
 * reported anything. A deployment refusing every write therefore looked like
 * ordinary typing, and the status bar's "1 unsaved" is what an edit you have
 * not saved yet looks like too.
 *
 * Reporting now happens where the failure does, so every path reports, and the
 * dirty set is kept so the next attempt retries the same work.
 */

const saveFiles = vi.fn<(...args: unknown[]) => Promise<void>>();
const toastError = vi.fn();
const consoleIde = vi.fn();

vi.mock('@/lib/repo', () => ({
  repositoryFor: () => ({
    saveFiles,
    updateProject: vi.fn().mockResolvedValue(undefined),
    roleFor: vi.fn().mockResolvedValue('owner'),
  }),
}));
vi.mock('@/stores/toastStore', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/stores/consoleStore', () => ({
  consoleLog: { ide: consoleIde, build: vi.fn(), preview: vi.fn() },
  useConsoleStore: { getState: () => ({ append: vi.fn() }) },
}));

const { useFileStore } = await import('@/stores/fileStore');

const openProject = () =>
  useFileStore.setState({
    projectId: 'p1',
    meta: null,
    files: { 'index.html': '<h1>hi</h1>' },
    dirs: [],
    role: 'owner',
    dirty: new Set(['index.html']),
    saving: false,
    error: null,
    lastSavedAt: null,
  });

beforeEach(() => {
  vi.useRealTimers();
  saveFiles.mockReset();
  toastError.mockReset();
  consoleIde.mockReset();
  openProject();
});

/**
 * Each case uses its own message. The report collapses repeats of the *same*
 * message for a while — a failing project retries on every edit — and that
 * memory is module state, so sharing one message across cases would have each
 * suppress the next.
 */
let refusal = 0;
const distinctRefusal = () =>
  new Error(`1 of 1 files were not saved: index.html (attempt ${(refusal += 1)})`);

describe('a save the database refused', () => {
  beforeEach(() => {
    saveFiles.mockRejectedValue(distinctRefusal());
  });

  it('says so, rather than failing quietly', async () => {
    await expect(useFileStore.getState().flush()).rejects.toThrow(/not saved/);

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/not saved/i);
    expect(toastError.mock.calls[0][1]).toMatch(/index\.html/);
  });

  it('reports from the path nobody is awaiting, which is most of them', async () => {
    // Exactly what `scheduleSave` and the visibility handler do.
    await useFileStore.getState().flush().catch(() => undefined);

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('keeps the full text where it can be read back', async () => {
    await useFileStore.getState().flush().catch(() => undefined);

    expect(consoleIde).toHaveBeenCalledWith(
      expect.stringContaining('index.html'),
      'error',
    );
  });

  it('keeps the work dirty so the next attempt retries it', async () => {
    await useFileStore.getState().flush().catch(() => undefined);

    expect([...useFileStore.getState().dirty]).toEqual(['index.html']);
    expect(useFileStore.getState().error).toMatch(/not saved/);
    expect(useFileStore.getState().saving).toBe(false);
    expect(useFileStore.getState().lastSavedAt).toBeNull();
  });

  it('does not repeat the same message once per keystroke', async () => {
    for (let i = 0; i < 4; i++) {
      useFileStore.setState({ dirty: new Set(['index.html']) });
      await useFileStore.getState().flush().catch(() => undefined);
    }

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('reports again when the failure changes', async () => {
    await useFileStore.getState().flush().catch(() => undefined);
    saveFiles.mockRejectedValue(distinctRefusal());
    useFileStore.setState({ dirty: new Set(['index.html']) });
    await useFileStore.getState().flush().catch(() => undefined);

    expect(toastError).toHaveBeenCalledTimes(2);
  });
});

describe('a save that worked', () => {
  it('says nothing, marks the work clean and records when', async () => {
    saveFiles.mockResolvedValue(undefined);

    await useFileStore.getState().flush();

    expect(toastError).not.toHaveBeenCalled();
    expect([...useFileStore.getState().dirty]).toEqual([]);
    expect(useFileStore.getState().error).toBeNull();
    expect(useFileStore.getState().lastSavedAt).toBeGreaterThan(0);
  });

  it('recovers after a failure, and clears the error it was showing', async () => {
    saveFiles.mockRejectedValueOnce(new Error('refused'));
    await useFileStore.getState().flush().catch(() => undefined);
    expect(useFileStore.getState().error).toBe('refused');

    saveFiles.mockResolvedValue(undefined);
    await useFileStore.getState().flush();

    expect(useFileStore.getState().error).toBeNull();
    expect([...useFileStore.getState().dirty]).toEqual([]);
  });
});

describe('an edit made while the write was in flight', () => {
  it('stays dirty rather than being marked as saved', async () => {
    let release: () => void = () => {};
    saveFiles.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const flushing = useFileStore.getState().flush();
    // `flush` reaches the repository a microtask later, through the save queue.
    await Promise.resolve();
    await Promise.resolve();
    // The file changes again before the write comes back.
    useFileStore.setState((state) => ({
      files: { ...state.files, 'index.html': '<h1>newer</h1>' },
      dirty: new Set(state.dirty).add('index.html'),
    }));
    release();
    await flushing;

    expect([...useFileStore.getState().dirty]).toEqual(['index.html']);
  });
});
