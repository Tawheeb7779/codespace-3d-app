import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Applies appearance settings to the document root. Theme, density and the
 * reduced-motion preference are attributes rather than classes so CSS can key
 * off them without a cascade fight.
 */
export function useTheme() {
  const { theme, density, reducedMotion } = useSettingsStore((s) => s.appearance);

  useEffect(() => {
    const root = document.documentElement;
    const resolve = () =>
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'forge-light'
          : 'forge-dark'
        : theme;

    root.dataset.theme = resolve();
    root.dataset.density = density;
    root.dataset.reducedMotion = String(reducedMotion);

    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      root.dataset.theme = resolve();
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme, density, reducedMotion]);
}

/** The Monaco theme id matching the current appearance. */
export function useMonacoTheme(): 'forge-dark' | 'forge-light' {
  const theme = useSettingsStore((s) => s.appearance.theme);
  if (theme === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'forge-light'
      : 'forge-dark';
  }
  return theme;
}
