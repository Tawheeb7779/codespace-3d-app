import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '@/components/ide/StatusBar';
import { useEditorStore } from '@/stores/editorStore';
import { useGitStore } from '@/stores/gitStore';
import { useFileStore } from '@/stores/fileStore';

/**
 * Whether the status bar can be hit with a finger.
 *
 * The bar is 24px of painted height and its items take theirs from it, so on a
 * phone every clickable reading came out 23px tall — measured in Chromium at
 * 390x844 — under the 24x24 CSS px pointer-target minimum. `e2e/a11y.mjs`
 * measures the real thing in a real browser; jsdom does no layout and cannot.
 *
 * What is checked here instead is the mechanism: that the clickable items
 * carry the class the design system uses to grow a hit area, and that the
 * readings which are not buttons do not. That is the part a refactor breaks,
 * and it is checked in the suite that runs on every commit rather than only in
 * the browser suite that does not.
 */

beforeEach(() => {
  useEditorStore.setState({
    activePath: 'src/main.js',
    problems: [],
    cursor: { line: 1, column: 1 },
  } as never);
  useGitStore.setState({
    repo: { initialized: true, head: 'main' },
    status: { clean: false, staged: [], unstaged: [{ path: 'src/main.js', kind: 'modified' }] },
  } as never);
  useFileStore.setState({
    dirty: new Set<string>(),
    saving: false,
    lastSavedAt: null,
    role: 'owner',
    error: null,
  } as never);
});

describe('hitting a status bar reading', () => {
  it('gives every clickable reading a finger-sized target', () => {
    render(<StatusBar />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(
        button.className,
        `"${button.getAttribute('aria-label') ?? button.textContent}" is clickable but not a tap target`,
      ).toContain('tap-target');
    }
  });

  /**
   * A reading is not a target. Giving a span a 32px transparent box would put
   * it over the neighbours on either side, which is worse than leaving it.
   */
  it('does not put a hit area on a reading nobody can click', () => {
    render(<StatusBar />);

    const preview = screen.getByText('main');
    const span = preview.closest('span.tap-target');
    // The branch name sits inside a button, so its own span is not a target.
    expect(span === null || span.tagName === 'BUTTON').toBe(true);
  });

  it('still names the problems reading for a screen reader', () => {
    render(<StatusBar />);

    expect(screen.getByRole('button', { name: 'Open the problems panel' })).toBeTruthy();
  });

  it('keeps the source control reading clickable and named', () => {
    render(<StatusBar />);

    const git = screen.getByRole('button', { name: 'Open source control' });
    expect(git.className).toContain('tap-target');
  });
});
