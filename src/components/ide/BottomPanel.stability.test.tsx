import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { BottomPanel } from '@/components/ide/BottomPanel';
import { useTerminalStore } from '@/stores/terminalStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStore } from '@/stores/uiStore';

/**
 * The panel must settle, and it must keep settling.
 *
 * A Zustand selector that builds a fresh object or array on every call never
 * compares equal to its own previous result, so the subscription fires forever:
 * React gives up with "Maximum update depth exceeded" — minified error #185 —
 * and takes the whole workspace down with it. The terminal session list is the
 * obvious place to reach for such a selector, because the panel wants three
 * fields of each session and not the rest of the store.
 *
 * This panel does not do that today: it reads the store whole, and its two
 * derived readings are counts, which are numbers and compare by value. The
 * point of this file is that the next person narrowing that subscription for
 * performance finds out here rather than in a browser.
 *
 * jsdom renders, so a runaway update really does throw here. What it cannot
 * show is a slow render — that is a browser question, and not what this is for.
 */

function setUp(sessionCount: number) {
  useEditorStore.setState({ problems: [], activePath: null });
  useUIStore.setState({ bottomTab: 'terminal' });
  useTerminalStore.setState({
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      id: `sess-${index}`,
      name: `Terminal ${index + 1}`,
      environment: 'project' as const,
      cwd: '',
      lines: [],
      history: [],
      running: false,
    })),
    activeId: sessionCount ? 'sess-0' : null,
  } as never);
}

beforeEach(() => setUp(1));

describe('the bottom panel settles instead of looping', () => {
  it('renders once with a single session', () => {
    expect(() => render(<BottomPanel />)).not.toThrow();
    expect(screen.getByRole('tab', { name: /terminal/i })).toBeTruthy();
  });

  /**
   * Several sessions is where a per-session projection would be built, so it is
   * the shape that would loop if one were introduced.
   */
  it('renders with several sessions', () => {
    setUp(4);

    expect(() => render(<BottomPanel />)).not.toThrow();
  });

  it('renders with no session yet, which is the first-open state', () => {
    setUp(0);

    expect(() => render(<BottomPanel />)).not.toThrow();
  });

  /**
   * A store write the panel is subscribed to must cause one settled re-render,
   * not an unbounded chain of them. A looping selector fails here rather than
   * on the first paint, because the loop needs a store update to start it.
   */
  it('settles after the session list changes underneath it', () => {
    render(<BottomPanel />);

    expect(() => act(() => setUp(3))).not.toThrow();
    expect(screen.getByRole('tab', { name: /terminal/i })).toBeTruthy();
  });
});
