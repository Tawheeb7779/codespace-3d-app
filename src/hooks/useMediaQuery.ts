import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Breakpoint the IDE uses to switch between desktop and mobile layouts. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 900px)');
}

/**
 * Whether the pointer is a finger rather than a cursor.
 *
 * Distinct from {@link useIsMobile}, and not interchangeable with it: width
 * decides which layout to draw, this decides whether an affordance exists at
 * all. Telling someone to press Shift+Enter on a device with no Shift key is
 * not a layout problem, and it stays wrong on a wide tablet.
 */
export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
