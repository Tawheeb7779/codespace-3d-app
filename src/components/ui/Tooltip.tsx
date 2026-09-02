import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: Side;
  /** Extra hint rendered dim, typically a keyboard shortcut. */
  hint?: string;
  delay?: number;
}

/**
 * Portal tooltip positioned from the trigger's bounding box. Shows on hover and
 * on keyboard focus, and hides on Escape so it never traps a reader.
 */
export function Tooltip({ content, children, side = 'bottom', hint, delay = 350 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();

  const place = useCallback(() => {
    const node = triggerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const gap = 8;
    const map: Record<Side, { top: number; left: number }> = {
      top: { top: rect.top - gap, left: rect.left + rect.width / 2 },
      bottom: { top: rect.bottom + gap, left: rect.left + rect.width / 2 },
      left: { top: rect.top + rect.height / 2, left: rect.left - gap },
      right: { top: rect.top + rect.height / 2, left: rect.right + gap },
    };
    setPosition(map[side]);
  }, [side]);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      place();
      setOpen(true);
    }, delay);
  }, [delay, place]);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open, hide]);

  const translate: Record<Side, string> = {
    top: 'translate(-50%, -100%)',
    bottom: 'translate(-50%, 0)',
    left: 'translate(-100%, -50%)',
    right: 'translate(0, -50%)',
  };

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const originalRef = (children as unknown as { ref?: unknown }).ref;
      if (typeof originalRef === 'function') originalRef(node);
      else if (originalRef && typeof originalRef === 'object') {
        (originalRef as { current: HTMLElement | null }).current = node;
      }
    },
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: () => {
      place();
      setOpen(true);
    },
    onBlur: hide,
    'aria-describedby': open ? id : undefined,
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ top: position.top, left: position.left, transform: translate[side] }}
            className={cx(
              'pointer-events-none fixed z-[100] max-w-xs animate-fade-in rounded border border-line',
              'bg-surface-overlay px-2 py-1 text-xs text-ink shadow-pop',
            )}
          >
            {content}
            {hint && <span className="ml-2 font-mono text-ink-faint">{hint}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
