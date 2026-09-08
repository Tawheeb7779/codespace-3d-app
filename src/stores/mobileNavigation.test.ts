import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '@/stores/uiStore';

/**
 * "Show me X" has to mean the same thing in both layouts.
 *
 * The desktop workspace shows every panel at once, so showing one is a matter
 * of which tab is selected. The mobile workspace shows exactly one pane and
 * reads `mobilePane`, so setting only the desktop state left the phone on
 * whatever pane it was already on — the status bar's error count, its source
 * control reading, and every palette command that reveals a panel all looked
 * broken there: you tapped, and the screen did not change.
 *
 * These pin the intent rather than the mechanism: after asking for something,
 * the pane that shows it is the pane in front.
 */

const ui = () => useUIStore.getState();

beforeEach(() => {
  useUIStore.getState().resetLayout();
  useUIStore.setState({ mobilePane: 'editor' });
});

describe('asking for a bottom-panel tab', () => {
  it('brings the pane that contains it to the front', () => {
    ui().setBottomTab('problems');

    expect(ui().bottomTab).toBe('problems');
    expect(ui().mobilePane).toBe('terminal');
  });

  it('still opens the panel on desktop, which is what it always did', () => {
    useUIStore.setState({ bottomOpen: false });

    ui().setBottomTab('output');

    expect(ui().bottomOpen).toBe(true);
    expect(ui().bottomTab).toBe('output');
  });
});

describe('asking for a sidebar panel', () => {
  it.each(['explorer', 'search', 'git', 'packages'] as const)(
    'puts %s in front of a phone, where those all live in Files',
    (panel) => {
      ui().setSidebarPanel(panel);

      expect(ui().sidebarPanel).toBe(panel);
      expect(ui().mobilePane).toBe('files');
    },
  );

  it('gives the assistant its own pane, because it has one', () => {
    ui().setSidebarPanel('assistant');

    expect(ui().sidebarPanel).toBe('assistant');
    expect(ui().mobilePane).toBe('assistant');
  });

  it('still collapses on a second ask, as it does on desktop', () => {
    ui().setSidebarPanel('git');
    expect(ui().sidebarOpen).toBe(true);

    ui().setSidebarPanel('git');

    expect(ui().sidebarOpen).toBe(false);
  });
});

describe('the bottom navigation still wins', () => {
  it('puts the pane a user picked in front of it', () => {
    ui().setSidebarPanel('git');
    expect(ui().mobilePane).toBe('files');

    ui().setMobilePane('preview');

    expect(ui().mobilePane).toBe('preview');
  });
});
