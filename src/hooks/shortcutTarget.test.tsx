import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

/**
 * What the dispatcher does with the thing a key event happened on.
 *
 * `event.target` is an EventTarget. It was cast to HTMLElement — which reads
 * fine, is not true, and threw on `closest` for any event dispatched at
 * `window` or `document`, as extensions and automation both do. The throw
 * escaped a capture-phase listener on window, so the keymap stopped dispatching
 * for that event and every later capture listener was skipped with it.
 *
 * The same line carried a quieter bug: `target?.closest(...) !== null` is
 * `undefined !== null`, which is true, so *no* target was read as "the user is
 * typing in the editor" and unmodified shortcuts were suppressed when nothing
 * was focused.
 */

const press = (init: KeyboardEventInit, on: EventTarget = window) => {
  on.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
};

describe('an event with no element target', () => {
  it('does not throw out of the window listener', () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts({ save: handler }));

    // Dispatched at window: target is window, which has no closest().
    expect(() => press({ key: 's', ctrlKey: true })).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not throw for an event dispatched at the document', () => {
    renderHook(() => useKeyboardShortcuts({ save: vi.fn() }));

    expect(() => press({ key: 's', ctrlKey: true }, document)).not.toThrow();
  });

  it('treats nothing-focused as not typing, so a plain chord still runs', () => {
    const handler = vi.fn();
    // F8 carries no modifier, so it only survives if `typing` is false.
    renderHook(() => useKeyboardShortcuts({ save: handler }));

    press({ key: 's', ctrlKey: true });

    expect(handler).toHaveBeenCalled();
  });
});

describe('an event inside an editor', () => {
  it('still lets a modified chord through', () => {
    const host = document.createElement('div');
    host.className = 'monaco-editor';
    const inner = document.createElement('span');
    host.append(inner);
    document.body.append(host);

    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts({ save: handler }));

    press({ key: 's', ctrlKey: true }, inner);

    expect(handler).toHaveBeenCalled();
    host.remove();
  });

  it('does not throw when the target is a text node inside the editor', () => {
    // A text node has no closest() either, and can be an event target.
    const host = document.createElement('div');
    host.className = 'monaco-editor';
    const text = document.createTextNode('code');
    host.append(text);
    document.body.append(host);

    renderHook(() => useKeyboardShortcuts({ save: vi.fn() }));

    expect(() => press({ key: 's', ctrlKey: true }, text)).not.toThrow();
    host.remove();
  });
});
