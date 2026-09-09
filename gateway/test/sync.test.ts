import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyncIndex,
  applyEditorDelete,
  applyEditorWrite,
  hashContent,
  planInitialSync,
  readContainerChange,
} from '../src/sync.ts';
import { PathError } from '../src/workspace.ts';
import { walkWorkspace } from '../src/watcher.ts';

/**
 * Two writers and no lock.
 *
 * The editor writes because somebody typed; the container writes because a
 * build ran. Neither can be made to wait for the other, so this suite is about
 * the three things that go wrong when they disagree: an infinite echo, a silent
 * overwrite, and a protected file being carried across in either direction.
 *
 * These run against a real temporary directory rather than a mocked filesystem,
 * because the questions are about what is actually on disk.
 */

let dir: string;
let index: SyncIndex;
const limits = { maxFileBytes: 1024 * 1024, maxFiles: 10_000 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tacode-sync-'));
  index = new SyncIndex();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (path: string, content: string, baseHash?: string) =>
  applyEditorWrite(dir, index, { path, content, baseHash }, limits);

describe('the editor writing into the container', () => {
  it('creates the file, and the directories above it', async () => {
    const result = await write('src/deep/main.ts', 'export const x = 1;\n');

    expect(result.status).toBe('written');
    expect(await readFile(join(dir, 'src/deep/main.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('says nothing changed when the content is already what it should be', async () => {
    await write('a.ts', 'same');

    expect((await write('a.ts', 'same')).status).toBe('unchanged');
  });

  it('refuses a path that would escape the workspace', async () => {
    await expect(write('../../etc/passwd', 'x')).rejects.toThrow(PathError);
  });

  it('refuses to carry a protected file into the container', async () => {
    for (const path of ['.env', '.ssh/id_rsa', '.git/config', 'node_modules/x/index.js']) {
      const result = await write(path, 'secret');
      expect(result, path).toMatchObject({ status: 'skipped', reason: 'protected path' });
    }
  });

  it('refuses a file bigger than the budget rather than moving it', async () => {
    const result = await applyEditorWrite(
      dir,
      index,
      { path: 'big.bin', content: 'x'.repeat(2000) },
      { maxFileBytes: 1000, maxFiles: 10 },
    );

    expect(result).toMatchObject({ status: 'skipped' });
  });

  it('deletes a file the editor removed', async () => {
    await write('gone.ts', 'x');

    await applyEditorDelete(dir, index, 'gone.ts');

    await expect(readFile(join(dir, 'gone.ts'))).rejects.toThrow();
  });
});

describe('the container writing back to the editor', () => {
  it('reports a file a process created', async () => {
    await writeFile(join(dir, 'generated.ts'), 'export const generated = true;\n');

    const change = await readContainerChange(dir, index, 'generated.ts', limits);

    expect(change).toMatchObject({ path: 'generated.ts' });
    expect(change?.content).toContain('generated');
  });

  /**
   * The loop this design exists to prevent:
   *
   *   editor writes → container filesystem changes → watcher fires →
   *   editor writes again → …
   *
   * Broken by content, not by a timer: the change the watcher saw hashes to
   * exactly what we just wrote, so it is our own echo and stops here.
   */
  it('does not report back the write the editor just made', async () => {
    await write('loop.ts', 'const a = 1;\n');

    const echo = await readContainerChange(dir, index, 'loop.ts', limits);

    expect(echo).toBeNull();
  });

  it('does report a genuine change to a file the editor had written', async () => {
    await write('loop.ts', 'const a = 1;\n');

    // A formatter in the container rewrites it.
    await writeFile(join(dir, 'loop.ts'), 'const a = 1\n');
    const change = await readContainerChange(dir, index, 'loop.ts', limits);

    expect(change?.content).toBe('const a = 1\n');
  });

  it('stops the echo after a container-originated change too', async () => {
    await writeFile(join(dir, 'x.ts'), 'first\n');
    await readContainerChange(dir, index, 'x.ts', limits);

    // Nothing has changed since; the next event for it is an echo.
    expect(await readContainerChange(dir, index, 'x.ts', limits)).toBeNull();
  });

  it('never carries a protected or dependency path back to the editor', async () => {
    await mkdir(join(dir, 'node_modules/react'), { recursive: true });
    await writeFile(join(dir, 'node_modules/react/index.js'), 'module.exports = {}');
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git/config'), '[core]');
    await writeFile(join(dir, '.env'), 'SECRET=1');

    for (const path of ['node_modules/react/index.js', '.git/config', '.env']) {
      expect(await readContainerChange(dir, index, path, limits), path).toBeNull();
    }
  });

  it('does not try to send a binary file to a text editor', async () => {
    await writeFile(join(dir, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    expect(await readContainerChange(dir, index, 'image.bin', limits)).toBeNull();
  });

  it('does not send a file larger than the budget', async () => {
    await writeFile(join(dir, 'huge.log'), 'x'.repeat(5000));

    expect(
      await readContainerChange(dir, index, 'huge.log', { maxFileBytes: 1000, maxFiles: 10 }),
    ).toBeNull();
  });
});

describe('when both sides changed the same file', () => {
  /**
   * The case where silently picking a winner destroys somebody's work. The
   * editor believed the file was one thing, the container made it another, and
   * the editor is now writing a third. Refused, and reported.
   */
  it('detects the conflict instead of overwriting', async () => {
    await write('shared.ts', 'original\n');
    const editorSaw = hashContent('original\n');

    // The container edits it behind the editor's back.
    await writeFile(join(dir, 'shared.ts'), 'changed by the build\n');

    const result = await write('shared.ts', 'changed by the user\n', editorSaw);

    expect(result.status).toBe('conflict');
    // And the container's version is still on disk, untouched.
    expect(await readFile(join(dir, 'shared.ts'), 'utf8')).toBe('changed by the build\n');
  });

  it('is not a conflict when the editor is writing what is already there', async () => {
    await write('shared.ts', 'original\n');
    await writeFile(join(dir, 'shared.ts'), 'agreed\n');

    const result = await write('shared.ts', 'agreed\n', hashContent('original\n'));

    expect(result.status).toBe('unchanged');
  });

  it('writes without complaint when the editor knows the current content', async () => {
    await write('shared.ts', 'first\n');

    const result = await write('shared.ts', 'second\n', hashContent('first\n'));

    expect(result.status).toBe('written');
  });

  it('writes a new file with no base, which cannot conflict with anything', async () => {
    expect((await write('brand-new.ts', 'x')).status).toBe('written');
  });
});

describe('the initial synchronisation', () => {
  /**
   * Three cases, and the middle one is the interesting one. A file the
   * container has with different content is not "needed": sending it would
   * overwrite a version nobody chose. Only a file the container does not have
   * at all can be pushed without a decision.
   */
  it('separates what is missing from what disagrees', async () => {
    const plan = planInitialSync(
      [
        { path: 'a.ts', hash: 'h1', size: 10 },
        { path: 'b.ts', hash: 'h2', size: 10 },
        { path: 'c.ts', hash: 'h3', size: 10 },
      ],
      [
        { path: 'a.ts', hash: 'h1', size: 10 },
        { path: 'b.ts', hash: 'different', size: 10 },
      ],
      limits,
    );

    // Identical on both sides, so there is nothing to do about it at all.
    expect(plan.needed).not.toContain('a.ts');
    expect(plan.diverged.map((entry) => entry.path)).not.toContain('a.ts');
    // Absent from the container: safe to send.
    expect(plan.needed).toEqual(['c.ts']);
    // Present and different: the person decides, and the container's hash goes
    // with it so the editor can show what it is disagreeing with.
    expect(plan.diverged).toEqual([{ path: 'b.ts', containerHash: 'different' }]);
  });

  it('skips protected and oversized files rather than failing the whole sync', () => {
    const plan = planInitialSync(
      [
        { path: '.env', hash: 'h', size: 10 },
        { path: 'big.bin', hash: 'h', size: 999_999 },
        { path: 'ok.ts', hash: 'h', size: 10 },
      ],
      [],
      { maxFileBytes: 1000, maxFiles: 100 },
    );

    expect(plan.needed).toEqual(['ok.ts']);
    expect(plan.skipped.map((entry) => entry.path)).toEqual(['.env', 'big.bin']);
  });

  /**
   * Reported, never deleted. A container's extra files are usually build output
   * somebody is serving, and deleting whatever the editor has not heard of is
   * how a sync destroys a `dist` mid-demo.
   */
  it('reports files the container has and the editor does not, without deleting them', () => {
    const plan = planInitialSync(
      [{ path: 'a.ts', hash: 'h', size: 1 }],
      [
        { path: 'a.ts', hash: 'h', size: 1 },
        { path: 'leftover.ts', hash: 'h', size: 1 },
        { path: 'node_modules/x.js', hash: 'h', size: 1 },
      ],
      limits,
    );

    expect(plan.stale).toEqual(['leftover.ts']);
  });

  it('refuses a project with more files than a workspace can hold', () => {
    const manifest = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, hash: 'h', size: 1 }));

    expect(() => planInitialSync(manifest, [], { maxFileBytes: 1000, maxFiles: 10 })).toThrow(
      /more files/,
    );
  });
});

describe('walking a workspace', () => {
  it('does not descend into dependency or build directories', async () => {
    await mkdir(join(dir, 'node_modules/react'), { recursive: true });
    await writeFile(join(dir, 'node_modules/react/index.js'), 'x');
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist/bundle.js'), 'x');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/main.ts'), 'x');
    await writeFile(join(dir, 'package.json'), '{}');

    const { paths } = await walkWorkspace(dir, 1000);

    expect(paths.sort()).toEqual(['package.json', 'src/main.ts']);
  });

  it('stops at the limit rather than enumerating an enormous tree', async () => {
    await mkdir(join(dir, 'many'), { recursive: true });
    for (let i = 0; i < 30; i++) await writeFile(join(dir, `many/f${i}.ts`), 'x');

    const { paths, truncated } = await walkWorkspace(dir, 10);

    expect(paths).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});
