import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceTopBar } from '@/components/ide/WorkspaceTopBar';
import { useFileStore } from '@/stores/fileStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useUIStore } from '@/stores/uiStore';

/**
 * The workspace bar at phone width.
 *
 * The mobile workspace is one pane chosen from the bottom navigation; it never
 * reads sidebarOpen, bottomOpen or previewOpen. The bar offered all three
 * toggles anyway, so a phone had three buttons that visibly did nothing — and
 * they took enough room that the project name, the one label that says which
 * project you are in, truncated away to an empty box.
 *
 * jsdom does no layout, so this cannot measure the truncation. What it pins is
 * the cause: at mobile width the bar offers no control the mobile layout
 * ignores.
 */

const setViewport = (width: number) => {
  // The component asks useIsMobile(), which is a matchMedia query. jsdom has no
  // real viewport, so the query is what has to be answered.
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: /max-width:\s*900px/.test(query) ? width <= 900 : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList,
  );
};

const mount = () =>
  render(
    <MemoryRouter>
      <WorkspaceTopBar onCommandPalette={() => {}} onNotifications={() => {}} />
    </MemoryRouter>,
  );

const PANEL_TOGGLES = ['Toggle sidebar', 'Toggle bottom panel', 'Toggle preview'];

beforeEach(() => {
  useFileStore.setState({
    meta: {
      id: 'p1',
      name: 'Invoicing service',
      language: 'TypeScript',
      description: null,
    } as never,
    files: {},
    dirs: [],
    dirty: new Set(),
    saving: false,
  });
  usePreviewStore.setState({ status: 'idle' });
  useUIStore.setState({ sidebarOpen: true, bottomOpen: true, previewOpen: true });
});

describe('at desktop width', () => {
  it('offers the panel toggles, because the desktop layout has panels', () => {
    setViewport(1440);
    mount();

    for (const label of PANEL_TOGGLES) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });
});

describe('at mobile width', () => {
  it('offers no panel toggle, because the mobile layout ignores all three', () => {
    setViewport(390);
    mount();

    for (const label of PANEL_TOGGLES) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('still shows which project you are in', () => {
    setViewport(390);
    mount();

    expect(screen.getByRole('heading', { name: 'Invoicing service' })).toBeTruthy();
  });

  it('keeps the controls a phone genuinely needs', () => {
    setViewport(390);
    mount();

    // Saving, exporting, running and the notification history are all reachable
    // only from here on a phone — dropping them with the toggles would trade one
    // bug for a worse one.
    expect(screen.getByRole('button', { name: 'Save all files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export project as ZIP' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Notifications/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });
});
