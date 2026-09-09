import { afterEach, describe, expect, it } from 'vitest';
import { useFileStore } from '@/stores/fileStore';
import { attachWorkspaceSync, detachWorkspaceSync } from '@/lib/terminal/fileStoreSync';

/**
 * The boundary between one project's container and another project's files.
 *
 * TA CODE has two terminal concepts and they must not blur into each other.
 * The Project Terminal belongs to the open project. The Linux container
 * terminal is a real workspace, and the gateway gives it exactly one bind mount
 * — the container for `(user, project)`. Nothing else about the user's account
 * is reachable from inside it.
 *
 * That boundary is only as good as the browser half. The sync engine reads the
 * file store, and the file store is replaced wholesale when somebody opens a
 * different project, so an engine attached for project A that keeps reading the
 * store after the switch is an engine pushing project B's source into project
 * A's container.
 */

/** A terminal client that records rather than connects. */
function recorder() {
  const pushed: Array<{ path: string; content: string }> = [];
  const deleted: string[] = [];
  const manifests: number[] = [];
  return {
    pushed,
    deleted,
    manifests,
    client: {
      containerId: 'tacode-' + 'a'.repeat(32),
      sendManifest: (files: Array<{ path: string }>) => manifests.push(files.length),
      pushFiles: (files: Array<{ path: string; content: string }>) => pushed.push(...files),
      deleteFiles: (paths: string[]) => deleted.push(...paths),
    },
  };
}

function loadProject(projectId: string, files: Record<string, string>): void {
  useFileStore.setState({
    projectId,
    meta: { id: projectId } as never,
    files,
    dirs: [],
    role: 'owner',
    dirty: new Set(),
  });
}

afterEach(() => {
  detachWorkspaceSync();
  useFileStore.setState({ projectId: null, meta: null, files: {}, dirs: [], dirty: new Set() });
});

describe('a sync engine attached to one project', () => {
  /**
   * The leak, stated as a test.
   *
   * Opening a different project replaces `files` in a single write. The store
   * subscription sees every path change at once, and without a guard it hands
   * all of them to the container belonging to the project that was open
   * before — writing one project's source into another's workspace.
   *
   * Nothing disposed the engine on a switch: `disposeContainerTerminals` exists
   * and was never called from anywhere.
   */
  it('never pushes another project’s files into its container', async () => {
    loadProject('proj-alpha', { 'alpha.ts': 'export const a = 1;\n' });
    const alpha = recorder();
    const sync = attachWorkspaceSync('proj-alpha', alpha.client);
    await sync.start();
    await sync.flush();
    alpha.pushed.length = 0;

    // The user opens a different project. This is exactly what `open()` does.
    loadProject('proj-beta', {
      'beta-secret.ts': 'export const BETA_ONLY = "confidential";\n',
      'beta-other.ts': 'export const b = 2;\n',
    });

    await sync.flush();

    expect(alpha.pushed.map((file) => file.path)).toEqual([]);
    const written = alpha.pushed.map((file) => file.content).join('');
    expect(written).not.toContain('confidential');
  });

  it('does not delete its own project’s files when another project is opened', async () => {
    loadProject('proj-alpha', { 'alpha.ts': 'export const a = 1;\n' });
    const alpha = recorder();
    const sync = attachWorkspaceSync('proj-alpha', alpha.client);
    await sync.start();
    await sync.flush();

    // Beta does not contain `alpha.ts`, so a naive diff reads it as removed.
    loadProject('proj-beta', { 'beta.ts': 'export const b = 2;\n' });
    await sync.flush();

    expect(alpha.deleted).toEqual([]);
  });

  it('applies nothing from the container once its project is no longer open', () => {
    loadProject('proj-alpha', { 'alpha.ts': 'export const a = 1;\n' });
    const alpha = recorder();
    const sync = attachWorkspaceSync('proj-alpha', alpha.client);

    loadProject('proj-beta', { 'beta.ts': 'export const b = 2;\n' });

    // A change frame from alpha's container, arriving after the switch. Writing
    // it would put alpha's files into beta's editor.
    sync.onChanged([{ path: 'from-alpha.ts', content: 'leaked\n', hash: 'a'.repeat(32) }], []);

    expect(useFileStore.getState().files['from-alpha.ts']).toBeUndefined();
    expect(useFileStore.getState().projectId).toBe('proj-beta');
  });

  it('still syncs normally while its own project is the open one', async () => {
    loadProject('proj-alpha', { 'alpha.ts': 'export const a = 1;\n' });
    const alpha = recorder();
    const sync = attachWorkspaceSync('proj-alpha', alpha.client);
    await sync.start();
    // The gateway's answer. `start` only offers a manifest; nothing is sent
    // until the plan says what the container is missing.
    await sync.onPlan({ needed: ['alpha.ts'], diverged: [], skipped: [] });
    await sync.flush();

    expect(alpha.pushed.map((file) => file.path)).toContain('alpha.ts');

    useFileStore.getState().writeFile('alpha.ts', 'export const a = 2;\n');
    await sync.flush();

    expect(alpha.pushed.filter((file) => file.path === 'alpha.ts')).toHaveLength(2);
  });

  it('joins one engine per project rather than starting a second', () => {
    loadProject('proj-alpha', {});
    const first = attachWorkspaceSync('proj-alpha', recorder().client);
    const second = attachWorkspaceSync('proj-alpha', recorder().client);

    expect(second).toBe(first);
  });
});
