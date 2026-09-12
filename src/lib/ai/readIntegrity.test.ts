import { describe, expect, it } from 'vitest';
import { MAX_WHOLE_FILE_CHARS, READ_BUDGET_CHARS, ReadCache } from '@/lib/ai/context';
import { runTool, type ToolContext } from '@/lib/ai/tools';

/**
 * What the agent is allowed to believe it has read.
 *
 * Three failures, each of which looks like a working agent right up until it
 * destroys something.
 *
 * A **partial read recorded as a whole one** makes the next full read answer
 * "unchanged since you read it earlier" — so the agent reasons about a fragment
 * believing it has the file, and concludes a function is missing because it was
 * on line 900.
 *
 * A **whole-file overwrite with no read** passes every staleness check, because
 * nothing is stale about a file nobody opened. Replacing it is not an edit; it
 * is a deletion with a new file in its place.
 *
 * An **unbounded read** fills the context window with one file, pushing the
 * earlier turns of the conversation out — after which the model is working from
 * a task it can no longer see.
 */

function context(files: Record<string, string>, cache = new ReadCache()): ToolContext {
  return {
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
  };
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

describe('paging a file', () => {
  it('returns the whole of a small file with no note', async () => {
    const ctx = context({ 'a.ts': 'one\ntwo\n' });
    const answer = await runTool('read_file', { path: 'a.ts' }, ctx);

    expect(answer).toContain('one');
    expect(answer).not.toMatch(/showing lines/);
  });

  it('returns the range that was asked for', async () => {
    const ctx = context({ 'a.ts': lines(100) });
    const answer = await runTool('read_file', { path: 'a.ts', from_line: 10, max_lines: 3 }, ctx);

    expect(answer).toContain('line 10');
    expect(answer).toContain('line 12');
    expect(answer).not.toContain('line 13');
  });

  it('numbers the lines as the file numbers them', async () => {
    const ctx = context({ 'a.ts': lines(100) });
    const answer = await runTool('read_file', { path: 'a.ts', from_line: 50, max_lines: 1 }, ctx);

    expect(answer).toMatch(/\b50\|\s*line 50/);
  });

  /** The note that stops a fragment being mistaken for a file. */
  it('says a paged read is only part of the file', async () => {
    const ctx = context({ 'a.ts': lines(100) });
    const answer = await runTool('read_file', { path: 'a.ts', from_line: 1, max_lines: 5 }, ctx);

    expect(answer).toMatch(/showing lines 1-5 of 100/);
    expect(answer).toMatch(/not all of it/i);
  });

  it('pages a very large file even when no range was asked for', async () => {
    const ctx = context({ 'big.ts': 'x'.repeat(MAX_WHOLE_FILE_CHARS + 1000).split('').join('\n') });
    const answer = await runTool('read_file', { path: 'big.ts' }, ctx);

    expect(answer).toMatch(/showing lines/);
  });

  it('ignores a nonsensical range rather than returning nothing', async () => {
    const ctx = context({ 'a.ts': lines(10) });
    const answer = await runTool('read_file', { path: 'a.ts', from_line: -5 }, ctx);

    expect(answer).toContain('line 1');
  });
});

describe('a paged read is never remembered as a whole one', () => {
  /** The core property: a fragment must not answer a later full read. */
  it('does not report the file as cached after a partial read', async () => {
    const cache = new ReadCache();
    const ctx = context({ 'a.ts': lines(100) }, cache);

    await runTool('read_file', { path: 'a.ts', from_line: 1, max_lines: 5 }, ctx);
    const second = await runTool('read_file', { path: 'a.ts' }, ctx);

    expect(second).not.toMatch(/unchanged since you read it/i);
    expect(second).toContain('line 100');
  });

  it('reports a whole file as cached on the second full read', async () => {
    const cache = new ReadCache();
    const ctx = context({ 'a.ts': lines(10) }, cache);

    await runTool('read_file', { path: 'a.ts' }, ctx);
    const second = await runTool('read_file', { path: 'a.ts' }, ctx);

    expect(second).toMatch(/unchanged since you read it/i);
  });

  it('does not count a partial read as a current read', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'part of it', true);

    expect(cache.hasCurrentRead('a.ts', 'part of it')).toBe(false);
  });

  it('counts a whole read as a current read', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'all of it', false);

    expect(cache.hasCurrentRead('a.ts', 'all of it')).toBe(true);
  });

  it('stops counting once the file changes', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'original', false);

    expect(cache.hasCurrentRead('a.ts', 'edited by someone else')).toBe(false);
  });
});

describe('overwriting a file requires having read it', () => {
  /** The case "not stale" lets through: a file the agent never opened. */
  it('refuses a whole-file write over a file that was never read', async () => {
    const ctx = context({ 'a.ts': 'important work\n' });

    await expect(
      runTool('write_file', { path: 'a.ts', content: 'replaced\n' }, ctx),
    ).rejects.toThrow(/have not read it/i);
    expect(ctx.files['a.ts']).toBe('important work\n');
  });

  it('allows the write once the file has been read whole', async () => {
    const cache = new ReadCache();
    const ctx = context({ 'a.ts': 'important work\n' }, cache);

    await runTool('read_file', { path: 'a.ts' }, ctx);
    await runTool('write_file', { path: 'a.ts', content: 'replaced\n' }, ctx);

    expect(ctx.files['a.ts']).toBe('replaced\n');
  });

  /** Reading one page is not reading the file. */
  it('refuses the write after only a partial read', async () => {
    const cache = new ReadCache();
    const ctx = context({ 'a.ts': lines(100) }, cache);

    await runTool('read_file', { path: 'a.ts', from_line: 1, max_lines: 5 }, ctx);

    await expect(
      runTool('write_file', { path: 'a.ts', content: 'replaced\n' }, ctx),
    ).rejects.toThrow(/have not read it/i);
  });

  /** Creating a file destroys nothing, so it needs no prior read. */
  it('allows creating a file that does not exist', async () => {
    const ctx = context({});

    await runTool('write_file', { path: 'new.ts', content: 'hello\n' }, ctx);

    expect(ctx.files['new.ts']).toBe('hello\n');
  });

  it('still refuses when the file changed after the read', async () => {
    const cache = new ReadCache();
    const files: Record<string, string> = { 'a.ts': 'original\n' };
    const ctx = context(files, cache);

    await runTool('read_file', { path: 'a.ts' }, ctx);
    files['a.ts'] = 'the user edited this\n';

    await expect(
      runTool('write_file', { path: 'a.ts', content: 'replaced\n' }, ctx),
    ).rejects.toThrow(/have not read it|changed after you read it/i);
  });

  /** A headless caller supplies neither hook and behaves as it always did. */
  it('does not require a read when the caller supplies no cache', async () => {
    const files: Record<string, string> = { 'a.ts': 'x\n' };
    const ctx: ToolContext = {
      files,
      dirs: [],
      canWrite: true,
      allowDestructive: false,
      writeFile: (path, content) => {
        files[path] = content;
      },
      deletePath: () => undefined,
      runShell: async () => '',
      terminalOutput: () => '',
    };

    await runTool('write_file', { path: 'a.ts', content: 'y\n' }, ctx);

    expect(files['a.ts']).toBe('y\n');
  });
});

describe('the reading budget', () => {
  it('allows reads within the budget', () => {
    const cache = new ReadCache();

    expect(cache.canRead(1000)).toBe(true);
  });

  it('refuses a read that would exceed it', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'x'.repeat(READ_BUDGET_CHARS), false);

    expect(cache.canRead(1)).toBe(false);
  });

  it('counts what has actually been sent', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'x'.repeat(500), false);

    expect(cache.spent).toBe(500);
  });

  /** A cached read costs nothing, because nothing was sent. */
  it('does not spend budget on a read that was answered from cache', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'x'.repeat(500), false);
    cache.record('a.ts', 'x'.repeat(500), false);

    expect(cache.spent).toBe(500);
  });

  it('tells the agent what to do instead of just refusing', async () => {
    const cache = new ReadCache();
    cache.record('used.ts', 'x'.repeat(READ_BUDGET_CHARS), false);
    const ctx = context({ 'a.ts': lines(10) }, cache);

    await expect(runTool('read_file', { path: 'a.ts' }, ctx)).rejects.toThrow(/search_files/);
  });

  it('is reset when a new task starts', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'x'.repeat(READ_BUDGET_CHARS), false);
    cache.clear();

    expect(cache.spent).toBe(0);
    expect(cache.canRead(1000)).toBe(true);
  });
});

describe('an edit clears what was read', () => {
  /** After the agent writes, its own record of the file is no longer current. */
  it('stops treating an edited file as read', () => {
    const cache = new ReadCache();
    cache.record('a.ts', 'original', false);
    cache.invalidate('a.ts');

    expect(cache.hasCurrentRead('a.ts', 'original')).toBe(false);
    expect(cache.isStale('a.ts', 'original')).toBe(false);
  });
});
