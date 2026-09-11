import { describe, expect, it } from 'vitest';
import { TOOLS, runTool, type ToolContext } from '@/lib/ai/tools';
import { AGENT_PANEL_NAMES, panelFor, readLine } from '@/lib/ai/ideActions';
import type { SidebarPanel } from '@/stores/uiStore';

/**
 * The agent moving the interface, and the two ways that must not go wrong.
 *
 * "Open src/App.tsx" should open the file. The failure that matters is the
 * quiet one: a tool that reports having opened something and did not, because
 * the path does not exist, the panel name was invented, or there is no editor
 * in this context at all. The agent then tells the user it is done and the
 * screen has not moved.
 *
 * So each of these is checked to *do* the thing when it can, and to say so
 * plainly when it cannot. None of them may close, hide or discard anything —
 * that is asserted too, because the set is meant to stay one-way.
 */

interface Driven {
  opened: Array<{ path: string; line?: number }>;
  panels: SidebarPanel[];
  previews: number;
  problems: number;
}

function context(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; driven: Driven } {
  const driven: Driven = { opened: [], panels: [], previews: 0, problems: 0 };
  const ctx: ToolContext = {
    files: { 'src/App.tsx': 'export const App = () => null;\n' },
    dirs: ['src'],
    canWrite: true,
    allowDestructive: false,
    writeFile: () => undefined,
    deletePath: () => undefined,
    runShell: async () => '',
    terminalOutput: () => '',
    ide: {
      openFile: (path, line) => driven.opened.push({ path, line }),
      openPanel: (panel) => driven.panels.push(panel),
      openPreview: () => {
        driven.previews += 1;
      },
      openProblems: () => {
        driven.problems += 1;
      },
    },
    ...overrides,
  };
  return { ctx, driven };
}

describe('open_file', () => {
  it('opens a file that exists', async () => {
    const { ctx, driven } = context();
    const answer = await runTool('open_file', { path: 'src/App.tsx' }, ctx);

    expect(driven.opened).toEqual([{ path: 'src/App.tsx', line: undefined }]);
    expect(answer).toContain('Opened src/App.tsx');
  });

  it('reveals a line when given one', async () => {
    const { ctx, driven } = context();
    await runTool('open_file', { path: 'src/App.tsx', line: 12 }, ctx);

    expect(driven.opened[0].line).toBe(12);
  });

  /** Refusing beats opening nothing and reporting success. */
  it('refuses a path that is not in the project', async () => {
    const { ctx, driven } = context();

    await expect(runTool('open_file', { path: 'src/Nope.tsx' }, ctx)).rejects.toThrow(
      /No such file/,
    );
    expect(driven.opened).toEqual([]);
  });

  it('normalises the path it is given', async () => {
    const { ctx, driven } = context();
    await runTool('open_file', { path: './src/App.tsx' }, ctx);

    expect(driven.opened[0].path).toBe('src/App.tsx');
  });

  /** A headless caller has no editor, and must be told rather than lied to. */
  it('says plainly when there is no editor', async () => {
    const { ctx } = context({ ide: undefined });
    const answer = await runTool('open_file', { path: 'src/App.tsx' }, ctx);

    expect(answer).toMatch(/no editor open in this context/i);
    expect(answer).not.toMatch(/^Opened/);
  });
});

describe('open_panel', () => {
  it('opens a panel by name', async () => {
    const { ctx, driven } = context();
    await runTool('open_panel', { panel: 'git' }, ctx);

    expect(driven.panels).toEqual(['git']);
  });

  /** An invented name must not silently resolve to some other panel. */
  it('refuses an unknown panel and lists the real ones', async () => {
    const { ctx, driven } = context();

    await expect(runTool('open_panel', { panel: 'wardrobe' }, ctx)).rejects.toThrow(
      /Unknown panel "wardrobe"/,
    );
    expect(driven.panels).toEqual([]);
  });

  it('offers only names it can actually resolve', () => {
    for (const name of AGENT_PANEL_NAMES) {
      expect(panelFor(name)).not.toBeNull();
    }
  });

  it('declares those same names in its schema', () => {
    const tool = TOOLS.find((entry) => entry.name === 'open_panel');

    expect(tool?.input_schema.properties.panel.enum).toEqual(AGENT_PANEL_NAMES);
  });

  it('says plainly when there is no workspace', async () => {
    const { ctx } = context({ ide: undefined });

    expect(await runTool('open_panel', { panel: 'git' }, ctx)).toMatch(/no workspace open/i);
  });
});

describe('open_preview and open_problems', () => {
  it('opens the preview', async () => {
    const { ctx, driven } = context();
    await runTool('open_preview', {}, ctx);

    expect(driven.previews).toBe(1);
  });

  it('opens the problems list', async () => {
    const { ctx, driven } = context();
    await runTool('open_problems', {}, ctx);

    expect(driven.problems).toBe(1);
  });

  it.each(['open_preview', 'open_problems'])('%s says plainly when there is no workspace', async (name) => {
    const { ctx } = context({ ide: undefined });

    expect(await runTool(name, {}, ctx)).toMatch(/no workspace open/i);
  });
});

describe('the shape of the set', () => {
  /**
   * These are navigation, not editing. Marking one `mutates` would also gate it
   * behind write permission, and a reader should be able to be shown a file.
   */
  it.each(['open_file', 'open_panel', 'open_preview', 'open_problems'])(
    '%s does not count as a write',
    (name) => {
      expect(TOOLS.find((entry) => entry.name === name)?.mutates).toBe(false);
    },
  );

  /** One-way by design: nothing here takes a panel or a file away. */
  it('has no tool that closes or hides anything', () => {
    const names = TOOLS.map((entry) => entry.name);

    expect(names.filter((name) => /^(close|hide|dismiss)_/.test(name))).toEqual([]);
  });

  it('lets a read-only user be shown a file', async () => {
    const { ctx, driven } = context({ canWrite: false });
    await runTool('open_file', { path: 'src/App.tsx' }, ctx);

    expect(driven.opened).toHaveLength(1);
  });
});

describe('reading a line number the model supplied', () => {
  it.each([
    [12, 12],
    ['12', 12],
    [12.7, 12],
  ])('reads %s as %s', (input, expected) => {
    expect(readLine(input)).toBe(expected);
  });

  it.each([undefined, null, 0, -3, 'soon', Number.NaN])('ignores %s', (input) => {
    expect(readLine(input)).toBeUndefined();
  });
});
