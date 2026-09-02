import { useCallback, useEffect, useRef } from 'react';
import { cx } from '@/lib/utils';

interface ResizerProps {
  orientation: 'vertical' | 'horizontal';
  /** Called with the pointer delta in pixels since the drag started. */
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
  label: string;
  /** Keyboard step size in pixels. */
  step?: number;
}

/**
 * Draggable panel divider. Pointer capture keeps the drag alive over iframes,
 * and arrow keys resize without a mouse so the layout is fully keyboard usable.
 */
export function Resizer({ orientation, onResize, onDoubleClick, label, step = 16 }: ResizerProps) {
  const start = useRef(0);
  const dragging = useRef(false);
  const vertical = orientation === 'vertical';

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragging.current) return;
      const current = vertical ? event.clientX : event.clientY;
      onResize(current - start.current);
      start.current = current;
    },
    [onResize, vertical],
  );

  const stop = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stop();
    };
  }, [onPointerMove, stop]);

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        dragging.current = true;
        start.current = vertical ? event.clientX : event.clientY;
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp';
        const forward = vertical ? 'ArrowRight' : 'ArrowDown';
        if (event.key === back) {
          event.preventDefault();
          onResize(-step);
        } else if (event.key === forward) {
          event.preventDefault();
          onResize(step);
        }
      }}
      className={cx(
        'group relative z-10 shrink-0 touch-none bg-line transition-colors hover:bg-accent focus-visible:bg-accent',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
      )}
    >
      {/* Invisible hit area so the 1px line is still easy to grab. */}
      <span
        aria-hidden
        className={cx(
          'absolute',
          vertical ? '-left-1.5 -right-1.5 inset-y-0' : '-top-1.5 -bottom-1.5 inset-x-0',
        )}
      />
    </div>
  );
}
