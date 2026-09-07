import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '@/stores/settingsStore';
import { chordFromEvent } from '@/hooks/useKeyboardShortcuts';

/**
 * The keymap has to describe chords the browser can actually produce.
 *
 * A binding is matched by comparing a string in the keymap against a string
 * built from a real `KeyboardEvent`. Nothing checks that the two can ever be
 * equal, so a plausible-looking spelling is a shortcut that silently does
 * nothing — no error, no warning, just a key that never works. Two of those
 * shipped: `mod+slash` and `mod+backslash`, where `event.key` reports `/` and
 * `\`. This is the test that would have caught them.
 */

/**
 * Key tokens that are words rather than characters. `chordFromEvent` lowercases
 * `event.key`, so anything here must be a real `KeyboardEvent.key` value in
 * lower case — this list is the contract, not a convenience.
 */
const NAMED_KEYS = new Set([
  'space',
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(['mod', 'ctrl', 'alt', 'shift']);

const chords = DEFAULT_KEYBINDINGS.flatMap((binding) => [
  ...(binding.alternate ?? []).map((keys) => ({ id: binding.id, keys })),
  { id: binding.id, keys: binding.keys },
]);

describe('every chord in the keymap', () => {
  it.each(chords)('$id — $keys is a chord a keyboard can produce', ({ keys }) => {
    const parts = keys.split('+');
    // A trailing '+' would split into an empty final token; '+' itself is a
    // legal key, so guard the shape rather than the character.
    expect(parts.length).toBeGreaterThan(0);

    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);

    for (const mod of mods) expect(MODIFIERS).toContain(mod);

    // Either one character, as `event.key` reports for a printable key, or a
    // known named key. A multi-character token that is not named is a word
    // someone invented, and it will never match.
    const ok = key.length === 1 || NAMED_KEYS.has(key);
    expect(ok, `"${key}" is neither a single character nor a known named key`).toBe(true);
  });

  it.each(chords)('$id — $keys survives a round trip through a real event', ({ keys }) => {
    const parts = keys.split('+');
    const key = parts[parts.length - 1];
    const mods = new Set(parts.slice(0, -1));

    const event = new KeyboardEvent('keydown', {
      // 'mod' is the primary modifier and 'ctrl' the other one, which is what
      // makes `ctrl+\`` a real second binding rather than a duplicate of
      // `mod+\``. Under jsdom, `isMac()` is false, so primary is Ctrl and the
      // other one is Meta.
      ctrlKey: mods.has('mod'),
      metaKey: mods.has('ctrl'),
      altKey: mods.has('alt'),
      shiftKey: mods.has('shift'),
      key: key === 'space' ? ' ' : key,
    });

    expect(chordFromEvent(event)).toBe(keys);
  });
});

describe('no two commands claim the same chord', () => {
  it('holds across primary bindings and alternates alike', () => {
    const owners = new Map<string, string[]>();
    for (const { id, keys } of chords) {
      owners.set(keys, [...(owners.get(keys) ?? []), id]);
    }

    const clashes = [...owners.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([keys, ids]) => `${keys} → ${ids.join(', ')}`);

    // The dispatcher takes the first match, so a duplicate is not a conflict
    // the user is told about — it is one command quietly shadowing another.
    expect(clashes).toEqual([]);
  });
});
