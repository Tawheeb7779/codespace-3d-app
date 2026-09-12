import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityBar } from '@/components/ide/ActivityBar';
import { CommandPalette, type Command } from '@/components/ide/CommandPalette';
import { useUIStore } from '@/stores/uiStore';
import { GROUP_LABEL, allPanels } from '@/lib/workspacePanels';

/**
 * Whether a person can find a panel, and whether they can hit it.
 *
 * Both used to fail in ways that no unit test would catch. Sixteen of the
 * twenty-three panels had no command, so they existed only as an icon; and in
 * a short window the rail compressed its buttons under the 24px target
 * minimum rather than scrolling. Those are the two things checked here.
 */

beforeEach(() => {
  useUIStore.setState({ sidebarPanel: 'explorer', sidebarOpen: true });
});

describe('the rail', () => {
  it('offers every panel the registry describes', () => {
    render(<ActivityBar />);

    for (const { info } of allPanels()) {
      expect(screen.getByRole('button', { name: info.label })).toBeTruthy();
    }
  });

  it('groups them rather than showing one undifferentiated column', () => {
    render(<ActivityBar />);

    const workspace = screen.getByRole('list', { name: GROUP_LABEL.primary });
    const tools = screen.getByRole('list', { name: GROUP_LABEL.advanced });

    expect(within(workspace).getByRole('button', { name: 'Explorer' })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: 'Database' })).toBeTruthy();
    // The file tree and the database studio are not peers.
    expect(within(workspace).queryByRole('button', { name: 'Database' })).toBeNull();
  });

  /**
   * The rail runs out of room before the panels do. It must scroll, because
   * the alternative the browser picks is shrinking every button — measured at
   * 23.8px tall in a 1440x720 window, under the 24px minimum.
   */
  it('scrolls when it runs out of room instead of shrinking its targets', () => {
    render(<ActivityBar />);
    const rail = screen.getByRole('navigation', { name: 'Workspace panels' });

    expect(rail.className).toContain('overflow-y-auto');
    for (const button of within(rail).getAllByRole('button')) {
      expect(button.className).toContain('shrink-0');
    }
  });

  it('selects a panel and says which is current', async () => {
    render(<ActivityBar />);

    await userEvent.click(screen.getByRole('button', { name: 'Source control' }));

    expect(useUIStore.getState().sidebarPanel).toBe('git');
    expect(screen.getByRole('button', { name: 'Source control' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Explorer' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});

describe('finding a panel by name', () => {
  const panelCommands = (): Command[] =>
    allPanels().map(({ id, info }) => ({
      id: `view.panel.${id}`,
      group: GROUP_LABEL[info.group],
      label: `Show ${info.label}`,
      keywords: info.keywords,
      run: () => useUIStore.getState().setSidebarPanel(id),
    }));

  const palette = () =>
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={panelCommands()}
        files={[]}
        onOpenFile={() => {}}
      />,
    );

  it('lists a command for every panel', () => {
    palette();

    for (const { info } of allPanels()) {
      expect(screen.getByText(`Show ${info.label}`)).toBeTruthy();
    }
  });

  /** The reason keywords exist: nobody types "Performance" to find a profiler. */
  it('finds a panel by what it does, not only by its name', async () => {
    palette();

    await userEvent.type(screen.getByLabelText('Search commands'), 'profiler');

    expect(screen.getByText('Show Performance')).toBeTruthy();
    expect(screen.queryByText('Show Explorer')).toBeNull();
  });

  it('runs the command it shows', async () => {
    palette();

    await userEvent.type(screen.getByLabelText('Search commands'), 'sql');
    await userEvent.click(screen.getByText('Show Database'));

    expect(useUIStore.getState().sidebarPanel).toBe('database');
  });

  it('says so when nothing matches rather than showing an empty list', async () => {
    palette();

    await userEvent.type(screen.getByLabelText('Search commands'), 'zzzznothing');

    expect(screen.getByText(/No matching commands/i)).toBeTruthy();
  });
});
