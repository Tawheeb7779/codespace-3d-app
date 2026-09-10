import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBuild } from '@/lib/preview';

/**
 * What a build that is no longer wanted is allowed to do.
 *
 * `run()` is asynchronous — esbuild-wasm takes as long as the project takes —
 * and two things can happen while it is in flight: the user can stop the
 * preview, and the files can change again. Both were mishandled.
 *
 *   - Stop cleared the document and set the status to idle, and then the build
 *     that was already running finished and put both back. The preview the user
 *     had dismissed reappeared, showing the code as it was before they stopped.
 *
 *   - A second run during a build returned immediately and left nothing behind.
 *     The panel's auto-rebuild only fires when the file map changes, so once
 *     that one request was dropped nothing asked again: the preview stayed on
 *     the older bundle indefinitely while the editor showed newer code.
 *
 * Both are about the same thing — a result outliving the request — so both are
 * settled the same way: a build proves it is still the current one before it
 * writes anything, and a request that arrives mid-build is remembered instead
 * of dropped.
 */

/** Resolve a build by hand so the window between request and result is ours. */
const pendingBuilds: Array<(build: PreviewBuild) => void> = [];

vi.mock('@/lib/preview', async () => ({
  buildPreview: vi.fn(
    () => new Promise<PreviewBuild>((resolve) => pendingBuilds.push(resolve)),
  ),
}));

const { usePreviewStore } = await import('@/stores/previewStore');
const { useFileStore } = await import('@/stores/fileStore');
const { buildPreview } = await import('@/lib/preview');

const built = (html: string): PreviewBuild => ({
  html,
  bytes: { js: html.length, css: 0, html: html.length },
  entry: 'src/main.ts',
  errors: [],
  warnings: [],
  externals: [],
  bundledPackages: [],
  durationMs: 5,
});

/** Let the store's continuation after `await buildPreview` actually run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Leave no build outstanding: `run` holds a module-level flag until the one it
 * started settles, so a test that abandoned a promise would wedge the next.
 */
afterEach(async () => {
  for (const resolve of pendingBuilds) resolve(built('<html>drained</html>'));
  await settle();
  await settle();
});

beforeEach(() => {
  pendingBuilds.length = 0;
  vi.mocked(buildPreview).mockClear();
  usePreviewStore.setState({
    status: 'idle',
    document: '',
    entry: '',
    errors: [],
    warnings: [],
    builtFrom: null,
    lastBuildMs: 0,
  });
  useFileStore.setState({ files: { 'src/main.ts': 'one' } });
});

describe('stopping a preview while it is still building', () => {
  it('stays stopped when the build it cancelled finishes', async () => {
    const run = usePreviewStore.getState().run();
    expect(usePreviewStore.getState().status).toBe('building');

    usePreviewStore.getState().stop();
    expect(usePreviewStore.getState().status).toBe('idle');

    // The build the user cancelled now completes.
    pendingBuilds[0](built('<html>stale</html>'));
    await run;
    await settle();

    expect(usePreviewStore.getState().status).toBe('idle');
    expect(usePreviewStore.getState().document).toBe('');
  });

  it('runs again after a stop, rather than being wedged shut', async () => {
    const first = usePreviewStore.getState().run();
    usePreviewStore.getState().stop();
    pendingBuilds[0](built('<html>stale</html>'));
    await first;
    await settle();

    const second = usePreviewStore.getState().run();
    expect(usePreviewStore.getState().status).toBe('building');
    pendingBuilds[1](built('<html>fresh</html>'));
    await second;

    expect(usePreviewStore.getState().status).toBe('running');
    expect(usePreviewStore.getState().document).toBe('<html>fresh</html>');
  });
});

describe('an edit that lands while a build is running', () => {
  it('is built rather than dropped', async () => {
    const first = usePreviewStore.getState().run();

    // The file changes and the panel asks for a rebuild mid-build.
    useFileStore.setState({ files: { 'src/main.ts': 'two' } });
    void usePreviewStore.getState().run();

    pendingBuilds[0](built('<html>one</html>'));
    await settle();

    // The second request must have reached the bundler.
    expect(buildPreview).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildPreview).mock.calls[1][0]).toEqual({ 'src/main.ts': 'two' });

    pendingBuilds[1](built('<html>two</html>'));
    await first;

    expect(usePreviewStore.getState().document).toBe('<html>two</html>');
    expect(usePreviewStore.getState().status).toBe('running');
    expect(usePreviewStore.getState().builtFrom).toEqual({ 'src/main.ts': 'two' });
  });

  it('collapses a burst of requests into one follow-up build', async () => {
    const first = usePreviewStore.getState().run();
    for (const source of ['two', 'three', 'four']) {
      useFileStore.setState({ files: { 'src/main.ts': source } });
      void usePreviewStore.getState().run();
    }

    pendingBuilds[0](built('<html>one</html>'));
    await settle();

    // One catch-up build, on the newest files — not three.
    expect(buildPreview).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildPreview).mock.calls[1][0]).toEqual({ 'src/main.ts': 'four' });

    pendingBuilds[1](built('<html>four</html>'));
    await first;
  });

  it('does not queue a rebuild behind a stop', async () => {
    const first = usePreviewStore.getState().run();
    useFileStore.setState({ files: { 'src/main.ts': 'two' } });
    void usePreviewStore.getState().run();
    usePreviewStore.getState().stop();

    pendingBuilds[0](built('<html>one</html>'));
    await first;
    await settle();

    expect(buildPreview).toHaveBeenCalledTimes(1);
    expect(usePreviewStore.getState().status).toBe('idle');
  });
});

describe('a build that fails after it stopped being wanted', () => {
  it('does not report its error over a stopped preview', async () => {
    const run = usePreviewStore.getState().run();
    usePreviewStore.getState().stop();

    pendingBuilds[0](null as unknown as PreviewBuild); // resolving with null throws downstream
    await run;
    await settle();

    expect(usePreviewStore.getState().status).toBe('idle');
    expect(usePreviewStore.getState().errors).toEqual([]);
  });
});
