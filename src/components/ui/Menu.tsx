import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/utils';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  items: MenuItem[];
  /** Viewport coordinates where the menu should appear. */
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  label?: string;
}

/**
 * Keyboard-navigable popup menu used for context menus and dropdowns.
 * Arrow keys move, Enter activates, Escape closes, and the menu flips when it
 * would otherwise overflow the viewport.
 */
export function Menu({ items, anchor, onClose, label = 'Actions' }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const enabled = items.filter((item) => !item.disabled);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const left = Math.min(anchor.x, window.innerWidth - rect.width - 8);
    const top =
      anchor.y + rect.height > window.innerHeight - 8
        ? Math.max(8, anchor.y - rect.height)
        : anchor.y;
    setPosition({ top, left: Math.max(8, left) });
  }, [anchor, items.length]);

  useEffect(() => {
    if (!anchor) return;
    setIndex(0);
    ref.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // `capture` so the menu closes before the click lands on whatever is behind it.
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const activate = useCallback(
    (item: MenuItem) => {
      onClose();
      item.onSelect();
    },
    [onClose],
  );

  if (!anchor || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ top: position.top, left: position.left }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setIndex((i) => (i + 1) % Math.max(1, enabled.length));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setIndex((i) => (i - 1 + enabled.length) % Math.max(1, enabled.length));
        } else if (event.key === 'Enter' && enabled[index]) {
          event.preventDefault();
          activate(enabled[index]);
        }
      }}
      className={cx(
        'fixed z-[90] min-w-[196px] animate-scale-in rounded border border-line',
        'bg-surface-overlay py-1 shadow-pop outline-none',
      )}
    >
      {items.map((item) => {
        const activeIndex = enabled.indexOf(item);
        return (
          <div key={item.id}>
            {item.separatorBefore && <div className="my-1 h-px bg-line" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => activeIndex >= 0 && setIndex(activeIndex)}
              onClick={() => activate(item)}
              className={cx(
                'flex w-full items-center gap-2.5 px-3 py-1 text-left text-base transition-colors',
                item.disabled && 'cursor-not-allowed text-ink-faint',
                !item.disabled && item.danger && 'text-danger',
                !item.disabled && !item.danger && 'text-ink',
                !item.disabled && activeIndex === index && 'bg-surface-raised',
              )}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-faint">
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="font-mono text-xs text-ink-faint">{item.shortcut}</span>
              )}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
