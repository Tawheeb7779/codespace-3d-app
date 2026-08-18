import { useCallback, useRef, type PointerEvent } from 'react';

interface UseResizeOptions {
  onResize: (delta: number) => void;
  direction: 'horizontal' | 'vertical';
}

export function useResize({ onResize, direction }: UseResizeOptions) {
  const startPos = useRef(0);
  const dragging = useRef(false);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragging.current = true;
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
      document.body.classList.add('no-select');

      const handleMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        const current = direction === 'horizontal' ? ev.clientX : ev.clientY;
        const delta = current - startPos.current;
        onResize(delta);
        startPos.current = current;
      };

      const handleUp = () => {
        dragging.current = false;
        document.body.classList.remove('no-select');
        window.removeEventListener('pointermove', handleMove as unknown as EventListener);
        window.removeEventListener('pointerup', handleUp);
      };

      window.addEventListener('pointermove', handleMove as unknown as EventListener);
      window.addEventListener('pointerup', handleUp);
    },
    [onResize, direction]
  );

  return handlePointerDown;
}
