import { describe, expect, it } from 'vitest';
import { ReadCache } from '@/lib/ai/context';
import { runTool, type ToolContext } from '@/lib/ai/tools';

/**
 * The agent fixing a file it just broke.
 *
 * This is the repair loop, and it is the most important thing the assistant
 * does: write, run the build, see it fail, write the fix, run the build again.
 *
 * The whole-file write rule says an existing file may only be overwritten by an
 * agent that has read it as it currently stands — it exists so the agent cannot
 * destroy content nobody looked at. Applied to the agent's *own* previous write
 * it is wrong, and it broke this loop: the second write was refused because the
 * first write had cleared the read record, so the agent could never fix its own
 * mistake without re-reading a file it had just authored.
 *
 * Content the agent wrote is content the agent has seen. That is the whole
 * distinction, and it keeps the safety property intact: an edit made by
 * *somebody else* still invalidates, which is what `noteExternalEdit` is for.
 */

function harness() {
  const files: Record<string, string> = { 'src/main.js': 'const original = 1;\n' };
  const cache = new ReadCache();

  const ctx: ToolContext = {
    files,
    dirs: [],
    canWrite: true,
    allowDestructive: false,
    writeFile: (path, content) => {
      files[path] = content;
    },
    deletePath: (path) => {
      delete files[path];
    },
    runShell: async () => '',
    terminalOutput: () => '',
    onRead: (path, content, partial) => cache.record(path, content, partial),
    isStaleRead: (path, content) => cache.isStale(path, content),
    hasCurrentRead: (path, content) => cache.hasCurrentRead(path, content),
    canRead: (chars) => cache.canRead(chars),
    /*
     * What the store does after a tool changes a file.
     *
     * The agent authored these bytes, so they are recorded as a current whole
     * read rather than dropped — which is exactly the change under test. A
     * deletion records nothing, because there is no content to have read.
     */
    onChange: (path, kind, _before, after) => {
      if (kind === 'deleted') cache.invalidate(path);
      else cache.record(path, after, false);
    },
  };

  return { ctx, files, cache };
}

describe('the repair loop', () => {
  it('lets the agent overwrite a file it just wrote', async () => {
    const { ctx, files } = harness();

    await runTool('read_file', { path: 'src/main.js' }, ctx);
    await runTool('write_file', { path: 'src/main.js', content: 'const broken = ;\n' }, ctx);

    // The build fails here in the real flow; the agent then writes the fix.
    await runTool(
      'write_file',
      { path: 'src/main.js', content: "document.title = 'recovered';\n" },
      ctx,
    );

    expect(files['src/main.js']).toBe("document.title = 'recovered';\n");
  });

  /** The scripted scenario the browser suite runs, without a prior read. */
  it('lets the agent fix a file it created in this task', async () => {
    const { ctx, files } = harness();

    await runTool('write_file', { path: 'src/new.js', content: 'const broken = ;\n' }, ctx);
    await runTool('write_file', { path: 'src/new.js', content: 'const fixed = 1;\n' }, ctx);

    expect(files['src/new.js']).toBe('const fixed = 1;\n');
  });

  it('allows repair to repeat, as a real loop does', async () => {
    const { ctx, files } = harness();

    await runTool('read_file', { path: 'src/main.js' }, ctx);
    for (const attempt of ['first', 'second', 'third']) {
      await runTool('write_file', { path: 'src/main.js', content: `const ${attempt} = 1;\n` }, ctx);
    }

    expect(files['src/main.js']).toBe('const third = 1;\n');
  });
});

describe('the safety property is unchanged', () => {
  /** The rule this was always for: never overwrite what nobody read. */
  it('still refuses to overwrite a file the agent never touched', async () => {
    const { ctx, files } = harness();

    await expect(
      runTool('write_file', { path: 'src/main.js', content: 'replaced\n' }, ctx),
    ).rejects.toThrow(/have not read it/i);
    expect(files['src/main.js']).toBe('const original = 1;\n');
  });

  /** Somebody else's edit still expires the agent's knowledge of the file. */
  it('refuses after an outside edit, even following the agent’s own write', async () => {
    const { ctx, files, cache } = harness();

    await runTool('write_file', { path: 'src/new.js', content: 'agent wrote this\n' }, ctx);
    // The user types in the editor: the store invalidates on their behalf.
    files['src/new.js'] = 'the user changed it\n';
    cache.invalidate('src/new.js');

    await expect(
      runTool('write_file', { path: 'src/new.js', content: 'clobbered\n' }, ctx),
    ).rejects.toThrow(/have not read it/i);
    expect(files['src/new.js']).toBe('the user changed it\n');
  });

  it('does not treat a deleted path as read', async () => {
    const { ctx, cache } = harness();

    await runTool('read_file', { path: 'src/main.js' }, ctx);
    await runTool('write_file', { path: 'src/main.js', content: 'x\n' }, ctx);
    cache.invalidate('src/main.js');

    expect(cache.hasCurrentRead('src/main.js', 'x\n')).toBe(false);
  });
});
