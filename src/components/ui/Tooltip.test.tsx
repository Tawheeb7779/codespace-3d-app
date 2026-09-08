import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Who a tooltip is for.
 *
 * It is a hover affordance plus a keyboard one: a mouse user points at an icon
 * and finds out what it does, a keyboard user tabs to it and gets the same.
 * `onFocus` does not distinguish those from a click or a tap, so pressing any
 * icon button also summoned its tooltip — and a dialog that moves focus to its
 * close button on open showed one immediately, sitting over the content it had
 * just opened. On a phone, where there is no hover to explain it, that read as
 * a label stuck to the screen.
 *
 * `:focus-visible` is the browser's own judgement about whether focus came
 * from the keyboard, so these pin behaviour against that rather than against
 * an input-device guess of our own.
 */

const mount = () =>
  render(
    <Tooltip content="Close dialog">
      <button type="button">×</button>
    </Tooltip>,
  );

const tip = () => screen.queryByRole('tooltip');

describe('focus from the keyboard', () => {
  it('shows the tooltip, which is the whole point of the focus trigger', async () => {
    mount();
    const button = screen.getByRole('button');

    // A real tab moves focus in a way jsdom reports as :focus-visible.
    button.focus();
    fireEvent.focus(button);

    await waitFor(() => expect(tip()).not.toBeNull());
    expect(tip()?.textContent).toContain('Close dialog');
  });

  it('hides again on blur', async () => {
    mount();
    const button = screen.getByRole('button');
    button.focus();
    fireEvent.focus(button);
    await waitFor(() => expect(tip()).not.toBeNull());

    fireEvent.blur(button);

    await waitFor(() => expect(tip()).toBeNull());
  });
});

describe('focus from a pointer', () => {
  it('shows nothing, because a tap is not a request for a label', async () => {
    mount();
    const button = screen.getByRole('button');

    // Pressing with a pointer focuses the button without :focus-visible.
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    fireEvent.focus(button);

    // Give the component the same chance it would have had to open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tip()).toBeNull();
  });
});

describe('hover', () => {
  it('still shows the tooltip after the delay', async () => {
    render(
      <Tooltip content="Save all files" delay={0}>
        <button type="button">save</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button');

    fireEvent.mouseEnter(button);

    await waitFor(() => expect(tip()).not.toBeNull());
    expect(tip()?.textContent).toContain('Save all files');
  });

  it('hides when the pointer leaves', async () => {
    render(
      <Tooltip content="Save all files" delay={0}>
        <button type="button">save</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(tip()).not.toBeNull());

    fireEvent.mouseLeave(button);

    await waitFor(() => expect(tip()).toBeNull());
  });
});
