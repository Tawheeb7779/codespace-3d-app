import { describe, expect, it } from 'vitest';
import { runTool, ToolError, type ToolContext } from '@/lib/ai/tools';
import { ReadCache } from '@/lib/ai/context';

/**
 * What happens when the user types while the agent is working.
 *
 * An agent turn runs up to a dozen steps over many seconds, and the user is not
 * locked out of the editor for the duration. So the two of them write to the
 * same files at the same time, and the question is what the agent does with
 * content that moved under it.
 *
 * The tool context used to hand tools the file map captured when the turn
 * began. Zustand replaces that object on every write, so the captured reference
 * stopped following the store: an edit computed against turn-start content was
 * applied to turn-start content, and whatever the user had typed meanwhile was
 * replaced by a tool that reported success. These pin the two halves of the
 * fix — read through to the store, and refuse a blind overwrite.
 */

/** A context that reads through to a mutable store, as the real one now does. */
function liveContext(
  store: { files: Record<string, string> },
  extra: Partial<ToolContext> = {},
): ToolContext {
  return {
    get files() {
      return store.files;
    },
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: (path, content) => {
      // Replacing the object is what the real store does, and is exactly what
      // a captured reference fails to follow.
      store.files = { ...store.files, [path]: content };
    },
    deletePath: (path) => {
      const next = { ...store.files };
      delete next[path];
      store.files = next;
    },
    runShell: async () => '',
    terminalOutput: () => '',
    ...extra,
  };
}

describe('an anchored edit while the user is typing', () => {
  it('keeps the line the user added elsewhere in the file', async () => {
    const store = { files: { 'src/a.ts': 'const a = 1;\nconst b = 2;\n' } };
    const ctx = liveContext(store);

    // The user adds a line in the editor, mid-turn.
    store.files = { 'src/a.ts': 'const a = 1;\nconst b = 2;\nconst mine = 3;\n' };

    await runTool(
      'edit_file',
      { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' },
      ctx,
    );

    const final = store.files['src/a.ts'];
    expect(final).toContain('const a = 42;');
    // The whole point: their work is still there.
    expect(final).toContain('const mine = 3;');
  });

  it('refuses when the user changed the very text it was going to replace', async () => {
    const store = { files: { 'src/a.ts': 'const a = 1;\n' } };
    const ctx = liveContext(store);

    store.files = { 'src/a.ts': 'const a = 99;\n' };

    // The anchor is gone, so the edit cannot be placed. Better an error the
    // agent can react to than a replacement of something it never saw.
    await expect(
      runTool(
        'edit_file',
        { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' },
        ctx,
      ),
    ).rejects.toThrow(/was not found/);
    expect(store.files['src/a.ts']).toBe('const a = 99;\n');
  });
});

describe('a whole-file overwrite', () => {
  const withCache = (store: { files: Record<string, string> }) => {
    const cache = new ReadCache();
    return {
      cache,
      ctx: liveContext(store, {
        onRead: (path, content) => cache.record(path, content),
        isStaleRead: (path, content) => cache.isStale(path, content),
      }),
    };
  };

  it('is refused when the file moved after the agent read it', async () => {
    const store = { files: { 'src/a.ts': 'original\n' } };
    const { ctx } = withCache(store);

    await runTool('read_file', { path: 'src/a.ts' }, ctx);
    // The user edits it while the agent composes a replacement.
    store.files = { 'src/a.ts': 'the user rewrote this\n' };

    await expect(
      runTool('write_file', { path: 'src/a.ts', content: 'agent version\n' }, ctx),
    ).rejects.toThrow(ToolError);
    expect(store.files['src/a.ts']).toBe('the user rewrote this\n');
  });

  it('names the file and says what to do about it', async () => {
    const store = { files: { 'src/a.ts': 'original\n' } };
    const { ctx } = withCache(store);
    await runTool('read_file', { path: 'src/a.ts' }, ctx);
    store.files = { 'src/a.ts': 'changed\n' };

    await expect(
      runTool('write_file', { path: 'src/a.ts', content: 'x\n' }, ctx),
    ).rejects.toThrow(/src\/a\.ts changed after you read it[\s\S]*Read it again/);
  });

  it('goes through when nothing moved', async () => {
    const store = { files: { 'src/a.ts': 'original\n' } };
    const { ctx } = withCache(store);

    await runTool('read_file', { path: 'src/a.ts' }, ctx);
    await runTool('write_file', { path: 'src/a.ts', content: 'agent version\n' }, ctx);

    expect(store.files['src/a.ts']).toBe('agent version\n');
  });

  it('still creates a file the agent never read', async () => {
    const store = { files: {} as Record<string, string> };
    const { ctx } = withCache(store);

    // Never read, so there is no stale copy to be working from. Refusing here
    // would block the agent from creating anything at all.
    await runTool('write_file', { path: 'src/new.ts', content: 'hello\n' }, ctx);

    expect(store.files['src/new.ts']).toBe('hello\n');
  });

  it('is unaffected for a caller that tracks no reads', async () => {
    const store = { files: { 'src/a.ts': 'original\n' } };
    const ctx = liveContext(store); // no onRead, no isStaleRead

    await runTool('write_file', { path: 'src/a.ts', content: 'agent version\n' }, ctx);

    expect(store.files['src/a.ts']).toBe('agent version\n');
  });
});

describe('the read cache staleness check', () => {
  it('is false for a file it has never seen', () => {
    expect(new ReadCache().isStale('a.ts', 'anything')).toBe(false);
  });

  it('is false while the content matches what was recorded', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'body');
    expect(cache.isStale('a.ts', 'body')).toBe(false);
  });

  it('is true once the content differs', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'body');
    expect(cache.isStale('a.ts', 'body changed')).toBe(true);
  });

  it('forgets a path that was invalidated, so the agent may write again', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'body');
    cache.invalidate('a.ts');
    expect(cache.isStale('a.ts', 'body changed')).toBe(false);
  });
});
