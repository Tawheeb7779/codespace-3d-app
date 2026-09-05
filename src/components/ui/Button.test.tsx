import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Why the label text lives in an element of its own.
 *
 * `Button` renders the spinner into the slot immediately before the label, so
 * React commits it with `insertBefore(icon, label)`. When the label was a bare
 * text node, anything that rewrites text in the page — Chrome's translate, a
 * password manager, an accessibility overlay — replaced that node, React's
 * stored reference went stale, and the next flip of `loading` threw
 *
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node': The node
 *   before which the new node is to be inserted is not a child of this node
 *
 * taking the whole dashboard down to the error boundary. Reproduced in
 * Chromium against the Create Project dialog, and fixed by making React's
 * reference an element that those layers rewrite *into* rather than replace.
 */

const childrenOf = (button: HTMLElement) => [...button.childNodes];
const textNodes = (button: HTMLElement) =>
  childrenOf(button).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());

describe('the label never sits in the button as a bare text node', () => {
  it('wraps a plain string label in an element', () => {
    render(<Button>Create project</Button>);
    const button = screen.getByRole('button', { name: 'Create project' });
    expect(textNodes(button)).toHaveLength(0);
    const span = button.querySelector('span');
    expect(span?.textContent).toBe('Create project');
  });

  it('wraps a numeric label too', () => {
    render(<Button>{42}</Button>);
    const button = screen.getByRole('button', { name: '42' });
    expect(textNodes(button)).toHaveLength(0);
  });

  /** The spinner is inserted directly before the label; that slot is the bug. */
  it('leaves an element between the spinner and the label, not a text node', () => {
    const { rerender } = render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    rerender(
      <Button loading>Save</Button>,
    );
    // The spinner mounted, and every remaining child is an element.
    expect(button.querySelector('svg')).not.toBeNull();
    expect(textNodes(button)).toHaveLength(0);
  });

  it('holds when the label is mixed with an icon', () => {
    render(
      <Button>
        <Plus className="h-3 w-3" />
        Add file
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Add file/ });
    expect(textNodes(button)).toHaveLength(0);
  });
});

describe('nothing else about the button changes', () => {
  it('keeps element children as their own children, so the flex gap is unchanged', () => {
    render(
      <Button>
        <Plus data-testid="icon" className="h-3 w-3" />
        <span data-testid="label">Add</span>
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Add/ });
    // Two element children in, two element children out: no extra wrapper was
    // introduced around anything that was already an element.
    expect(button.children).toHaveLength(2);
    expect(button.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(button.querySelector('[data-testid="label"]')).not.toBeNull();
  });

  it('adds no child at all when there is no label', () => {
    render(<Button aria-label="Refresh" leading={<Loader2 />} />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button.children).toHaveLength(1);
  });

  it('still exposes the label as the accessible name', () => {
    render(<Button>Create project</Button>);
    expect(screen.getByRole('button', { name: 'Create project' })).toBeTruthy();
  });

  it('still shows the spinner and disables itself while loading', () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole('button', { name: 'Saving' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('renders leading and trailing content around the label', () => {
    render(
      <Button leading={<Plus data-testid="lead" />} trailing={<Plus data-testid="trail" />}>
        Middle
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Middle/ });
    expect(button.children).toHaveLength(3);
    expect(button.children[0].getAttribute('data-testid')).toBe('lead');
    expect(button.children[2].getAttribute('data-testid')).toBe('trail');
  });
});
