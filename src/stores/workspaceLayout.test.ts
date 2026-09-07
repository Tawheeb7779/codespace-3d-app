import { beforeEach, describe, expect, it } from 'vitest';
import { LAYOUTS, useUIStore } from '@/stores/uiStore';

/**
 * Named arrangements of the panels, and the way out of focus mode.
 *
 * None of this is new state — every preset is a set of values for panels that
 * already existed. What it adds is saying "I am debugging now" in one keystroke
 * instead of dragging four dividers, and, crucially, getting back afterwards.
 *
 * That last part is the whole reason focus mode remembers: a mode you can enter
 * with a keystroke and can only leave by rebuilding your layout by hand is a
 * trap, not a feature.
 */

const layout = () => useUIStore.getState();

beforeEach(() => {
  useUIStore.getState().resetLayout();
});

describe('choosing a layout', () => {
  it('applies exactly what the preset describes', () => {
    useUIStore.getState().applyLayout('git');

    const preset = LAYOUTS.find((entry) => entry.id === 'git')!;
    expect(layout().sidebarPanel).toBe(preset.apply.sidebarPanel);
    expect(layout().sidebarOpen).toBe(preset.apply.sidebarOpen);
    expect(layout().previewOpen).toBe(preset.apply.previewOpen);
    expect(layout().bottomOpen).toBe(preset.apply.bottomOpen);
    expect(layout().layout).toBe('git');
  });

  it('leaves the sizes a user set alone', () => {
    useUIStore.getState().setSidebarWidth(420);
    useUIStore.getState().setBottomHeight(300);

    useUIStore.getState().applyLayout('debugging');

    // A preset says which panels are open, not how wide they are — those are
    // the user's, and overwriting them would make presets destructive.
    expect(layout().sidebarWidth).toBe(420);
    expect(layout().bottomHeight).toBe(300);
  });

  it('ignores a name that is not a layout', () => {
    useUIStore.getState().applyLayout('coding');
    const before = { ...layout() };

    useUIStore.getState().applyLayout('nonsense' as never);

    expect(layout().layout).toBe(before.layout);
    expect(layout().sidebarPanel).toBe(before.sidebarPanel);
  });
});

describe('focus mode', () => {
  it('clears the workspace down to the editor', () => {
    useUIStore.getState().applyLayout('coding');

    useUIStore.getState().toggleFocus();

    expect(layout().layout).toBe('focus');
    expect(layout().sidebarOpen).toBe(false);
    expect(layout().previewOpen).toBe(false);
    expect(layout().bottomOpen).toBe(false);
  });

  it('puts back the arrangement it replaced', () => {
    useUIStore.getState().setSidebarPanel('git');
    useUIStore.setState({ previewOpen: false, bottomOpen: true, bottomTab: 'problems' });
    const before = {
      sidebarPanel: layout().sidebarPanel,
      sidebarOpen: layout().sidebarOpen,
      previewOpen: layout().previewOpen,
      bottomOpen: layout().bottomOpen,
      bottomTab: layout().bottomTab,
    };

    useUIStore.getState().toggleFocus();
    useUIStore.getState().toggleFocus();

    expect(layout().sidebarPanel).toBe(before.sidebarPanel);
    expect(layout().sidebarOpen).toBe(before.sidebarOpen);
    expect(layout().previewOpen).toBe(before.previewOpen);
    expect(layout().bottomOpen).toBe(before.bottomOpen);
    expect(layout().bottomTab).toBe(before.bottomTab);
    expect(layout().layout).toBeNull();
  });

  it('does nothing when asked for the state it is already in', () => {
    useUIStore.getState().applyLayout('coding');
    const before = layout().sidebarOpen;

    useUIStore.getState().toggleFocus(false);

    expect(layout().sidebarOpen).toBe(before);
    expect(layout().layout).toBe('coding');
  });

  it('can be entered and left explicitly, not only toggled', () => {
    useUIStore.getState().applyLayout('coding');

    useUIStore.getState().toggleFocus(true);
    expect(layout().layout).toBe('focus');

    useUIStore.getState().toggleFocus(true);
    expect(layout().layout).toBe('focus');

    useUIStore.getState().toggleFocus(false);
    expect(layout().layout).toBeNull();
    expect(layout().sidebarOpen).toBe(true);
  });

  it('still leaves a usable workspace if there is nothing remembered', () => {
    // A session restored straight into focus mode has no "before" to go back
    // to; leaving must not strand the user with every panel shut.
    useUIStore.setState({ layout: 'focus', beforeFocus: null, sidebarOpen: false });

    useUIStore.getState().toggleFocus(false);

    expect(layout().layout).toBeNull();
    expect(layout().sidebarOpen).toBe(true);
  });
});

describe('resetting the layout', () => {
  it('forgets the chosen preset as well as the geometry', () => {
    useUIStore.getState().applyLayout('preview');
    useUIStore.getState().toggleFocus();

    useUIStore.getState().resetLayout();

    expect(layout().layout).toBeNull();
    expect(layout().beforeFocus).toBeNull();
    expect(layout().sidebarOpen).toBe(true);
  });
});
