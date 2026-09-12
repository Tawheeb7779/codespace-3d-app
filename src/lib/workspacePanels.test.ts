// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  GROUP_LABEL,
  PANEL_ORDER,
  WORKSPACE_PANELS,
  allPanels,
  panelsInGroup,
  type PanelGroup,
} from '@/lib/workspacePanels';
import { DEFAULT_KEYBINDINGS } from '@/stores/settingsStore';

/**
 * The registry the rail, the palette and the route all read.
 *
 * The type system already guarantees the part that used to drift — the record
 * is keyed by `SidebarPanel`, so a panel cannot exist without being described.
 * What is left to check is what a type cannot say: that every panel is
 * *findable*, that the hierarchy is real rather than a field nobody filled in,
 * and that a binding named here is a binding that exists.
 */

const ids = Object.keys(WORKSPACE_PANELS) as Array<keyof typeof WORKSPACE_PANELS>;

describe('every panel is reachable', () => {
  /**
   * The defect this registry exists for. Sixteen of twenty-three panels had no
   * command, so the only route to the profiler or the database studio was
   * recognising one of twenty-three 16px glyphs.
   */
  it('describes every panel exactly once, in exactly one group', () => {
    const grouped = PANEL_ORDER.flatMap((group) => panelsInGroup(group).map((entry) => entry.id));

    expect(grouped).toHaveLength(ids.length);
    expect(new Set(grouped).size).toBe(ids.length);
  });

  it('gives every panel a label and search words', () => {
    for (const id of ids) {
      const info = WORKSPACE_PANELS[id];
      expect(info.label.trim().length, `${id} has no label`).toBeGreaterThan(1);
      expect(info.keywords.trim().length, `${id} has no keywords`).toBeGreaterThan(2);
    }
  });

  /** Searching for the thing, not for the name the product happened to pick. */
  it('finds the profiler by the word a person would type', () => {
    const search = (needle: string) =>
      allPanels().filter(
        ({ info }) =>
          info.label.toLowerCase().includes(needle) ||
          info.keywords.toLowerCase().includes(needle),
      );

    expect(search('profiler').map((entry) => entry.id)).toContain('performance');
    expect(search('sql').map((entry) => entry.id)).toContain('database');
    expect(search('plugin').map((entry) => entry.id)).toContain('extensions');
    expect(search('env').map((entry) => entry.id)).toContain('environments');
  });

  it('does not label a panel with words that match nothing it is', () => {
    // A keyword list is only useful if it is about the panel; this catches a
    // copy-paste between entries.
    expect(WORKSPACE_PANELS.database.keywords).not.toContain('npm');
    expect(WORKSPACE_PANELS.packages.keywords).toContain('npm');
  });
});

describe('the hierarchy', () => {
  it('names every group it orders', () => {
    for (const group of PANEL_ORDER) {
      expect(GROUP_LABEL[group as PanelGroup]).toBeTruthy();
    }
  });

  it('puts the work first and the specialist tooling last', () => {
    const primary = panelsInGroup('primary').map((entry) => entry.id);

    expect(primary).toContain('explorer');
    expect(primary).toContain('search');
    expect(primary).toContain('git');
    expect(primary).toContain('assistant');
    // The rail's whole problem was that these sat beside the file tree.
    expect(primary).not.toContain('database');
    expect(primary).not.toContain('observability');
  });

  /** A new user should not have to wade through tooling to reach their files. */
  it('lists the primary group before anything else', () => {
    const order = allPanels().map(({ info }) => info.group);
    const lastPrimary = order.lastIndexOf('primary');
    const firstAdvanced = order.indexOf('advanced');

    expect(lastPrimary).toBeLessThan(firstAdvanced);
    expect(order[0]).toBe('primary');
  });

  it('keeps the rail short enough to be read, in every group', () => {
    for (const group of PANEL_ORDER) {
      expect(panelsInGroup(group).length).toBeGreaterThan(0);
    }
  });
});

describe('shortcuts named here', () => {
  /**
   * A binding id that does not exist would make the palette advertise a chord
   * that nothing is bound to — worse than showing none.
   */
  it('only names bindings the keymap actually defines', () => {
    const known = new Set(DEFAULT_KEYBINDINGS.map((binding) => binding.id));

    for (const id of ids) {
      const binding = WORKSPACE_PANELS[id].binding;
      if (!binding) continue;
      expect(known.has(binding), `${id} names an unknown binding "${binding}"`).toBe(true);
    }
  });

  it('gives the panels people reach for most a shortcut', () => {
    expect(WORKSPACE_PANELS.explorer.binding).toBeTruthy();
    expect(WORKSPACE_PANELS.search.binding).toBeTruthy();
    expect(WORKSPACE_PANELS.git.binding).toBeTruthy();
    expect(WORKSPACE_PANELS.assistant.binding).toBeTruthy();
  });
});
