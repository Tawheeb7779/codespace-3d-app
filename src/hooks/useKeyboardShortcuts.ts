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
      // A chord a user has bound always wins over a fixed alternate, so
      // rebinding a command can never be shadowed by another one's convenience
      // chord.
      const binding =
        keybindings.find((b) => b.keys === chord) ??
        keybindings.find((b) => b.alternate?.includes(chord));
      if (!binding) return;
      const handler = handlers[binding.id];
      if (!handler) return;

      /*
       * `event.target` is an EventTarget, not an Element.
       *
       * It was cast to HTMLElement, which reads fine and is not true: a key
       * event dispatched at `window` or `document` — which extensions and
       * automation both do — has a target with no `closest`, so this threw.
       * The throw escaped a capture-phase listener on window, which is the one
       * place it does real damage: the keymap stops dispatching for that event
       * and every later capture listener is skipped too.
       */
      const node = event.target;
      const target = node instanceof Element ? node : null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        (target instanceof HTMLElement && target.isContentEditable) ||
        target?.closest('.monaco-editor') != null ||
        target?.closest('.xterm') != null;
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
