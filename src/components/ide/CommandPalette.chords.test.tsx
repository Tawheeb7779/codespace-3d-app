import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommandPalette, type Command } from '@/components/ide/CommandPalette';
import { useSettingsStore, DEFAULT_KEYBINDINGS } from '@/stores/settingsStore';

/**
 * The chords the palette advertises.
 *
 * They used to be literals written beside each command — a second copy of
 * something Settings → Keyboard can change. The copy did not move: rebind
 * "Save file" and the palette went on advertising Ctrl+S, which is worse than
 * showing nothing, because it is confidently wrong. Naming the binding instead
 * means there is only ever one answer to "what runs this".
 */

const noop = () => {};

const open = (commands: Command[]) =>
  render(
    <CommandPalette
      open
      onClose={noop}
      commands={commands}
      files={[]}
      onOpenFile={noop}
    />,
  );

beforeEach(() => {
  useSettingsStore.setState({ keybindings: DEFAULT_KEYBINDINGS });
});

describe('a command that names a binding', () => {
  it('shows the chord that binding currently has', () => {
    open([{ id: 'a', label: 'Save all files', group: 'File', binding: 'save', run: noop }]);

    const row = screen.getByRole('option', { name: /Save all files/ });
    expect(row.textContent).toContain('Ctrl+S');
  });

  it('follows the binding when the user rebinds it', () => {
    useSettingsStore.getState().setKeybinding('save', 'mod+alt+s');

    open([{ id: 'a', label: 'Save all files', group: 'File', binding: 'save', run: noop }]);

    const row = screen.getByRole('option', { name: /Save all files/ });
    expect(row.textContent).toContain('Ctrl+Alt+S');
    // And crucially, not the chord it shipped with.
    expect(row.textContent).not.toContain('Ctrl+S+');
  });

  it('shows nothing rather than a guess when the binding is unknown', () => {
    open([{ id: 'a', label: 'Mystery', group: 'View', binding: 'nosuchbinding', run: noop }]);

    const row = screen.getByRole('option', { name: /Mystery/ });
    expect(row.textContent).toBe('ViewMystery');
  });
});

describe('a command with a literal chord', () => {
  it('still shows it, for the keys the keymap does not own', () => {
    // F8 for "next problem" is not a rebindable command; a literal is correct
    // there, and removing the escape hatch would lose a real shortcut.
    open([{ id: 'a', label: 'Go to next problem', group: 'Problems', keys: 'f8', run: noop }]);

    const row = screen.getByRole('option', { name: /Go to next problem/ });
    expect(row.textContent).toContain('F8');
  });
});
