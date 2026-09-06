import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { Resizer } from '@/components/ui/Resizer';

/**
 * A drag has to survive the render it causes.
 *
 * `onResize` is passed as an inline arrow by every caller — `onResize={(delta)
 * => setSidebarWidth(sidebarWidth + delta)}` — so it is a new function on every
 * render of the page. The listener effect had that function in its dependency
 * list, which meant each pointermove ran this sequence:
 *
 *   move -> onResize -> the page re-renders -> the effect tears down ->
 *   its cleanup calls stop() -> dragging is false -> every later move ignored
 *
 * The divider therefore moved once and stopped, and the user had to press,
 * drag, release and press again for each step. What follows drives the real
 * events and counts how far the divider actually got.
 */

// jsdom has no PointerEvent; the events themselves only carry coordinates.
class Pointer extends MouseEvent {}
const pointer = (type: string, init: MouseEventInit = {}) =>
  new Pointer(type, init) as unknown as PointerEvent;

const down = (node: Element, x: number) =>
  act(() => {
    node.dispatchEvent(
      pointer('pointerdown', { clientX: x, clientY: x, bubbles: true, cancelable: true }),
    );
  });

/** `buttons` is 1 while a button is held and 0 once it is not. */
const move = (x: number, buttons = 1) =>
  act(() => {
    window.dispatchEvent(pointer('pointermove', { clientX: x, clientY: x, buttons }));
  });

const up = () =>
  act(() => {
    window.dispatchEvent(pointer('pointerup'));
  });

describe('dragging a divider', () => {
  it('keeps following the pointer while the page re-renders under it', () => {
    const widths: number[] = [];
    let width = 240;

    /** A caller shaped like the real one: inline arrow, state on each move. */
    function Host() {
      const [w, setW] = useState(240);
      width = w;
      return (
        <Resizer
          orientation="vertical"
          label="Resize sidebar"
          onResize={(delta) => {
            widths.push(delta);
            setW(w + delta);
          }}
        />
      );
    }

    const { getByRole } = render(<Host />);
    const handle = getByRole('separator');

    down(handle, 100);
    move(110);
    move(120);
    move(130);
    up();

    // Three moves, three reports — not one and then silence.
    expect(widths).toEqual([10, 10, 10]);
    // Each step is applied to the size the previous one produced, which is
    // what the real caller does with `setSidebarWidth(sidebarWidth + delta)`.
    expect(width).toBe(270);
  });

  it('stops reporting once the pointer is released', () => {
    const deltas: number[] = [];
    const { getByRole } = render(
      <Resizer orientation="vertical" label="Resize" onResize={(d) => deltas.push(d)} />,
    );

    down(getByRole('separator'), 100);
    move(110);
    up();
    move(200);

    expect(deltas).toEqual([10]);
  });

  it('leaves the document cursor alone once the drag ends', () => {
    const { getByRole } = render(
      <Resizer orientation="vertical" label="Resize" onResize={() => {}} />,
    );

    down(getByRole('separator'), 100);
    expect(document.body.style.cursor).toBe('col-resize');
    up();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  /**
   * Releasing the button outside the browser window delivers no pointerup, so
   * the divider used to still believe it was being dragged: moving the pointer
   * back over the page resized the panel with no button held.
   */
  it('gives up the drag when the button was released outside the window', () => {
    const deltas: number[] = [];
    const { getByRole } = render(
      <Resizer orientation="vertical" label="Resize" onResize={(d) => deltas.push(d)} />,
    );

    down(getByRole('separator'), 100);
    move(110);
    // The user let go somewhere off-window; the next move carries no buttons.
    move(200, 0);
    move(300);

    expect(deltas).toEqual([10]);
    expect(document.body.style.cursor).toBe('');
  });

  /**
   * The preview divider sits next to a cross-origin iframe, which swallows
   * pointer events once the pointer crosses into it. Capturing the pointer on
   * pointerdown retargets every later event to the handle, so the drag keeps
   * running over the preview instead of dying at its edge.
   */
  it('captures the pointer so the drag survives crossing an iframe', () => {
    const captured: number[] = [];
    const released: number[] = [];
    Element.prototype.setPointerCapture = function (id: number) {
      captured.push(id);
    };
    Element.prototype.releasePointerCapture = function (id: number) {
      released.push(id);
    };
    Element.prototype.hasPointerCapture = () => true;

    const { getByRole } = render(
      <Resizer orientation="vertical" label="Resize" onResize={() => {}} />,
    );
    down(getByRole('separator'), 100);
    expect(captured.length).toBe(1);
    up();
    expect(released.length).toBe(1);
  });

  it('does not hold the cursor after the divider is unmounted mid-drag', () => {
    const { getByRole, unmount } = render(
      <Resizer orientation="horizontal" label="Resize" onResize={() => {}} />,
    );

    down(getByRole('separator'), 100);
    expect(document.body.style.cursor).toBe('row-resize');
    unmount();
    expect(document.body.style.cursor).toBe('');
  });
});
