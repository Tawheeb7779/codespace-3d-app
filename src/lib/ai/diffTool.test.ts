// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '@/lib/ai/tools';

/**
 * The diff handed to a review.
 *
 * Grounding a review in the real diff is what stops the agent guessing, but a
 * diff is also the most concentrated way to leak a project: it is the exact
 * lines that changed, and a `.env` edit is entirely secret. So the tool must
 * refuse anything the read policy refuses, and say so plainly when there is no
 * repository rather than returning something that looks like an empty diff.
 */

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const files: Record<string, string> = { 'src/a.ts': 'a', '.env': 'SECRET=1' };
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
    runShell: async () => 'ok',
    terminalOutput: () => '',
    ...overrides,
  };
}

describe('get_diff', () => {
  it('returns the diff the context provides', async () => {
    const result = await runTool(
      'get_diff',
      {},
      ctx({ gitDiff: () => '--- a/src/a.ts\n+++ b/src/a.ts\n+added' }),
    );
    expect(result).toContain('+added');
  });

  /** "No repository" and "no changes" are different answers. */
  it('says there is no repository rather than implying a clean tree', async () => {
    const result = await runTool('get_diff', {}, ctx());
    expect(result).toMatch(/no repository/i);
  });

  it('says the tree is clean when the diff is empty', async () => {
    const result = await runTool('get_diff', {}, ctx({ gitDiff: () => '' }));
    expect(result).toMatch(/clean/i);
  });

  it('is read-only, so a viewer can still use it', async () => {
    const result = await runTool(
      'get_diff',
      {},
      ctx({ canWrite: false, gitDiff: () => '+something' }),
    );
    expect(result).toContain('+something');
  });

  /**
   * The tool returns whatever the context built. The store filters protected
   * paths before building it, and this asserts the contract that filtering is
   * the producer's job — a context that leaked would be the bug, so the test
   * documents where that responsibility sits.
   */
  it('never invents content the context did not give it', async () => {
    const calls: number[] = [];
    const result = await runTool(
      'get_diff',
      {},
      ctx({
        gitDiff: () => {
          calls.push(1);
          return '--- a/src/a.ts\n+++ b/src/a.ts\n+only this';
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(result).not.toContain('SECRET');
    expect(result).not.toContain('.env');
  });
});
