import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from '@/components/ui/Field';

/**
 * Seeing what you typed.
 *
 * A password field gives no feedback but a row of dots, so a typo costs a
 * failed sign-in to discover. That is bad on a desktop keyboard and worse on a
 * phone one. The reveal toggle lives in the primitive rather than at each call
 * site, so every password and API-key field in the product has it.
 */

describe('a password field', () => {
  it('starts hidden, which is the point of a password field', () => {
    render(<Input label="Password" type="password" defaultValue="hunter2" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();
  });

  it('reveals the characters when asked, and says so', () => {
    render(<Input label="Password" type="password" defaultValue="hunter2" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    const toggle = screen.getByRole('button', { name: 'Hide password' });
    // aria-pressed is how a screen reader user learns the text is now exposed.
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides them again', () => {
    render(<Input label="Password" type="password" defaultValue="hunter2" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('keeps what was typed across the toggle', () => {
    render(<Input label="Password" type="password" defaultValue="hunter2" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('hunter2');
  });

  it('leaves autocomplete alone, so password managers still work', () => {
    render(<Input label="Password" type="password" autoComplete="current-password" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });
});

describe('every other kind of field', () => {
  it('has no toggle, because there is nothing hidden to reveal', () => {
    render(<Input label="Email" type="email" />);

    expect(screen.queryByRole('button', { name: /password/i })).toBeNull();
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
  });

  it('still renders a plain field with no type at all', () => {
    render(<Input label="Project name" />);

    expect(screen.getByLabelText('Project name')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /password/i })).toBeNull();
  });
});
