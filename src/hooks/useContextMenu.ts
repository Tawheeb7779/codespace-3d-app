import { useCallback, useState } from 'react';

/** Convenience hook: tracks the anchor point for a context menu. */
export function useContextMenu() {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const open = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }) => {
    event.preventDefault();
    setAnchor({ x: event.clientX, y: event.clientY });
  }, []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open, close };
}
