import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { DEFAULT_KEYBINDINGS, useSettingsStore } from '@/stores/settingsStore';

/**
 * The second chord people arrive with.
 *
 * Forge's own bindings are Cmd/Ctrl+K for the palette and Cmd/Ctrl+J for the
 * panel, and those are the ones a user owns and can rebind. But almost everyone
 * comes from an editor where the palette is Shift+Cmd/Ctrl+P and the terminal
 * is Ctrl+`, and pressing those and getting nothing reads as the shortcut being
 * broken. Each binding may therefore carry a fixed `alternate` chord that runs
 * the same command.
 *
 * The one rule that matters is precedence: a chord a user has deliberately
 * bound must never be swallowed by some other command's convenience chord.
 */

function Harness({ handlers }: { handlers: Record<string, () => void> }) {
  useKeyboardShortcuts(handlers);
  return null;
}

/** Dispatch at the body, which is where a keystroke lands with nothing focused. */
const press = (init: KeyboardEventInit) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));

beforeEach(() => {
  useSettingsStore.setState({ keybindings: DEFAULT_KEYBINDINGS });
});

describe('the chord a user owns', () => {
  it('opens the palette on the configured binding', () => {
    const commandPalette = vi.fn();
    render(<Harness handlers={{ commandPalette }} />);

    press({ key: 'k', ctrlKey: true });

    expect(commandPalette).toHaveBeenCalledTimes(1);
  });
});

describe('the fixed alternate chord', () => {
  it('opens the palette on the chord other editors use', () => {
    const commandPalette = vi.fn();
    render(<Harness handlers={{ commandPalette }} />);

    press({ key: 'p', ctrlKey: true, shiftKey: true });

    expect(commandPalette).toHaveBeenCalledTimes(1);
  });

  it('toggles the panel on Ctrl+backtick where mod is Ctrl', () => {
    const toggleTerminal = vi.fn();
    render(<Harness handlers={{ toggleTerminal }} />);

    press({ key: '`', ctrlKey: true });

    expect(toggleTerminal).toHaveBeenCalledTimes(1);
  });

  /**
   * The same physical shortcut, on the platform where it normalises
   * differently: mod is Cmd there, so a bare Ctrl lands in the other modifier
   * slot and the chord reads `ctrl+\`` rather than `mod+\``. Both are listed,
   * which is the whole reason `alternate` holds more than one chord.
   */
  it('toggles the panel on Ctrl+backtick on macOS, where mod is Cmd', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const toggleTerminal = vi.fn();
    render(<Harness handlers={{ toggleTerminal }} />);

    press({ key: '`', ctrlKey: true });

    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
  });

  it('survives the user rebinding the primary chord', () => {
    useSettingsStore.getState().setKeybinding('commandPalette', 'mod+alt+o');
    const commandPalette = vi.fn();
    render(<Harness handlers={{ commandPalette }} />);

    press({ key: 'p', ctrlKey: true, shiftKey: true });

    expect(commandPalette).toHaveBeenCalledTimes(1);
  });
});

describe('precedence', () => {
  it('gives a chord to the command a user bound it to, not to an alternate', () => {
    // Someone binds "next tab" to the palette's alternate chord. Theirs wins.
    useSettingsStore.getState().setKeybinding('nextTab', 'mod+shift+p');
    const commandPalette = vi.fn();
    const nextTab = vi.fn();
    render(<Harness handlers={{ commandPalette, nextTab }} />);

    press({ key: 'p', ctrlKey: true, shiftKey: true });

    expect(nextTab).toHaveBeenCalledTimes(1);
    expect(commandPalette).not.toHaveBeenCalled();
  });
});

describe('rebinding', () => {
  it('changes the chord and keeps the alternate the release ships', () => {
    useSettingsStore.getState().setKeybinding('commandPalette', 'mod+alt+o');
    const palette = useSettingsStore.getState().keybindings.find((b) => b.id === 'commandPalette');

    expect(palette?.keys).toBe('mod+alt+o');
    expect(palette?.alternate).toEqual(['mod+shift+p']);
  });

  it('puts the shipped chords back on reset', () => {
    useSettingsStore.getState().setKeybinding('commandPalette', 'mod+alt+o');
    useSettingsStore.getState().resetKeybindings();

    expect(useSettingsStore.getState().keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });
});
