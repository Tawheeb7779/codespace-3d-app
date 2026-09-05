import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '@/components/ide/StatusBar';
import { useEditorStore } from '@/stores/editorStore';
import { useFileStore } from '@/stores/fileStore';
import { useGitStore } from '@/stores/gitStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useAuthStore } from '@/stores/authStore';

/**
 * The status bar at narrow widths.
 *
 * The bar is a fixed 24px line. It used to let each reading shrink below its
 * own text width, so on a phone every label wrapped to a second line and
 * painted outside the bar, over the bottom navigation: "build failed" became
 * "build" / "failed", "Ln 2, Col 20" collided with the Terminal tab.
 *
 * jsdom does no layout, so these cannot measure pixels — the browser pass is
 * what proves the rendering. What they can pin is the contract that makes the
 * layout impossible to break again: nothing wraps, nothing escapes the bar,
 * and the readings a phone can do without are the ones that stand down.
 */

function setUp({ activePath = 'src/main.ts' }: { activePath?: string | null } = {}) {
  useAuthStore.setState({ localMode: true });
  useEditorStore.setState({ activePath, cursor: { line: 2, column: 20 }, problems: [] });
  useFileStore.setState({
    dirty: new Set(),
    saving: false,
    lastSavedAt: Date.now() - 60_000,
    role: 'owner',
  });
  useGitStore.setState({
    repo: { ...useGitStore.getState().repo, initialized: true, head: 'main' },
    status: { ...useGitStore.getState().status, clean: true, staged: [], unstaged: [] },
  });
  usePreviewStore.setState({ status: 'error' });
}

const bar = () => document.querySelector('footer')!;
const items = () => [...bar().children].flatMap((group) => [...group.children]) as HTMLElement[];
const withText = (needle: string) =>
  items().find((el) => (el.textContent ?? '').includes(needle));

beforeEach(() => setUp());

describe('the status bar cannot spill out of its one line', () => {
  it('renders every reading on a single line', () => {
    render(<StatusBar />);
    for (const item of items()) {
      expect(item.className, item.textContent ?? '').toContain('whitespace-nowrap');
    }
  });

  it('clips anything that still does not fit, rather than painting over the nav', () => {
    render(<StatusBar />);
    expect(bar().className).toContain('overflow-hidden');
    expect(bar().className).toContain('h-6');
  });

  it('holds each reading at its natural width instead of squeezing it', () => {
    render(<StatusBar />);
    // Only the branch name gives way, and it ellipsises when it does.
    const branch = withText('main')!;
    expect(branch.className).toContain('shrink');
    expect(branch.className).not.toContain('shrink-0');
    expect(branch.querySelector('.truncate')).not.toBeNull();

    for (const item of items().filter((el) => el !== branch)) {
      expect(item.className, item.textContent ?? '').toContain('shrink-0');
    }
  });
});

describe('what stands down on a phone', () => {
  /** Cursor position, indent size and language are the losable readings. */
  it('hides the minor readings below the sm breakpoint only', () => {
    render(<StatusBar />);
    for (const needle of ['Ln 2, Col 20', 'Spaces:', 'TypeScript']) {
      const item = withText(needle);
      expect(item, needle).toBeDefined();
      expect(item!.className, needle).toContain('hidden');
      expect(item!.className, needle).toContain('sm:flex');
    }
  });

  it('keeps the readings that carry real information at every width', () => {
    render(<StatusBar />);
    // A failed build, the problem counts, the storage mode and whether work is
    // saved all survive a 320px viewport.
    for (const needle of ['build failed', 'Local', 'saved', 'main']) {
      const item = withText(needle);
      expect(item, needle).toBeDefined();
      expect(item!.className, needle).not.toContain('hidden');
    }
  });

  it('drops the relative time from the save reading, not the word itself', () => {
    render(<StatusBar />);
    const saved = withText('saved')!;
    expect(saved.textContent).toContain('saved');
    const time = [...saved.querySelectorAll('span')].find((el) =>
      /ago|just now/.test(el.textContent ?? ''),
    );
    expect(time?.className).toContain('hidden');
    expect(time?.className).toContain('sm:inline');
  });

  it('still shows nothing editor-specific when no file is open', () => {
    setUp({ activePath: null });
    render(<StatusBar />);
    expect(screen.queryByText(/Spaces:/)).toBeNull();
    expect(screen.queryByText(/^Ln /)).toBeNull();
  });
});
