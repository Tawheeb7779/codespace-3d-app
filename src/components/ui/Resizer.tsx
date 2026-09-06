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

  /**
   * Every caller passes `onResize` as an inline arrow closing over the current
   * size, so it is a different function after each move. Read it through a ref
   * rather than depending on it: with it in the effect's dependencies, the
   * render each move caused tore the listeners down, the cleanup called `stop`,
   * and the drag ended after a single step.
   */
  const latestResize = useRef(onResize);
  latestResize.current = onResize;

  /** The handle, so the drag can hold the pointer and give it back. */
  const handleRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);

  const stop = useCallback(() => {
    dragging.current = false;
    if (pointerId.current !== null) {
      // Capturing is what keeps the drag alive over the preview iframe; give it
      // back rather than leaving the handle holding the pointer.
      handleRef.current?.releasePointerCapture?.(pointerId.current);
      pointerId.current = null;
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragging.current) return;
      // Releasing the button outside the browser window delivers no pointerup,
      // so the drag would otherwise still be live when the pointer came back —
      // the panel resizing with nothing held down. `buttons` says the truth.
      if (event.buttons === 0) {
        stop();
        return;
      }
      const current = vertical ? event.clientX : event.clientY;
      latestResize.current(current - start.current);
      start.current = current;
    },
    [vertical, stop],
  );

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
      ref={handleRef}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        dragging.current = true;
        start.current = vertical ? event.clientX : event.clientY;
        // Without this the pointer is lost the moment it crosses into the
        // preview iframe, which is exactly where the preview divider is
        // dragged. Capturing retargets every later event to this handle.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerId.current = event.pointerId;
        } catch {
          // Older engines and synthetic events; the window listeners still work
          // everywhere except over a cross-origin frame.
        }
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
      }}
      onLostPointerCapture={stop}
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
