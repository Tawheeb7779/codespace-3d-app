import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { isMac } from '@/lib/utils';

export type ShortcutHandlers = Record<string, (event: KeyboardEvent) => void>;

/** Normalise a keyboard event into the chord format used by the keymap. */
export function chordFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (mod) parts.push('mod');
  // The non-primary modifier still matters (Ctrl on macOS, Meta on Windows).
  if (isMac() ? event.ctrlKey : event.metaKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  const key = event.key.toLowerCase();
  const named: Record<string, string> = { ' ': 'space', escape: 'escape', enter: 'enter' };
  parts.push(named[key] ?? key);
  return parts.join('+');
}

export function formatChord(chord: string): string {
  const mac = isMac();
  return chord
    .split('+')
    .map((part) => {
      if (part === 'mod') return mac ? '⌘' : 'Ctrl';
      if (part === 'alt') return mac ? '⌥' : 'Alt';
      if (part === 'shift') return mac ? '⇧' : 'Shift';
      if (part === 'ctrl') return mac ? '⌃' : 'Ctrl';
      if (part === 'enter') return '↵';
      return part.toUpperCase();
    })
    .join(mac ? '' : '+');
}

/**
 * Global keymap dispatcher.
 *
 * Handlers are looked up by binding id, so a user rebinding a command in
 * settings changes behaviour without touching any component. Shortcuts that
 * would type into a field are suppressed unless they carry a modifier.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const keybindings = useSettingsStore((s) => s.keybindings);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = chordFromEvent(event);
      const binding = keybindings.find((b) => b.keys === chord);
      if (!binding) return;
      const handler = handlers[binding.id];
      if (!handler) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable ||
        target?.closest('.monaco-editor') !== null ||
        target?.closest('.xterm') !== null;
      // Inside an editor, only modified chords are ours; plain keys belong to it.
      if (typing && !chord.includes('mod') && !chord.includes('alt')) return;

      event.preventDefault();
      event.stopPropagation();
      handler(event);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handlers, keybindings]);
}
