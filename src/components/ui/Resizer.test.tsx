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

const move = (x: number) =>
  act(() => {
    window.dispatchEvent(pointer('pointermove', { clientX: x, clientY: x }));
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
