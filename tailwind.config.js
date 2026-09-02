/** @type {import('tailwindcss').Config} */

/**
 * Colours are declared as RGB channel triples in `src/index.css` so a single
 * `data-theme` attribute swaps the whole palette while Tailwind opacity
 * modifiers (`bg-surface/60`) keep working.
 */
const channel = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: channel('--c-canvas'),
        surface: {
          DEFAULT: channel('--c-surface'),
          raised: channel('--c-surface-raised'),
          sunken: channel('--c-surface-sunken'),
          overlay: channel('--c-surface-overlay'),
        },
        line: {
          DEFAULT: channel('--c-line'),
          strong: channel('--c-line-strong'),
        },
        ink: {
          DEFAULT: channel('--c-ink'),
          muted: channel('--c-ink-muted'),
          faint: channel('--c-ink-faint'),
        },
        accent: {
          DEFAULT: channel('--c-accent'),
          soft: channel('--c-accent-soft'),
          ink: channel('--c-accent-ink'),
        },
        positive: channel('--c-positive'),
        caution: channel('--c-caution'),
        danger: channel('--c-danger'),
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.06em' }],
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '20px' }],
        md: ['14px', { lineHeight: '22px' }],
        lg: ['16px', { lineHeight: '24px' }],
        xl: ['20px', { lineHeight: '28px', letterSpacing: '-0.01em' }],
        '2xl': ['26px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        '3xl': ['34px', { lineHeight: '40px', letterSpacing: '-0.025em' }],
        '4xl': ['46px', { lineHeight: '52px', letterSpacing: '-0.03em' }],
        '5xl': ['60px', { lineHeight: '64px', letterSpacing: '-0.035em' }],
      },
      borderRadius: {
        DEFAULT: '6px',
        sm: '4px',
        lg: '10px',
        xl: '14px',
      },
      boxShadow: {
        panel: '0 1px 0 0 rgb(var(--c-line) / 0.6)',
        pop: '0 16px 48px -12px rgb(0 0 0 / 0.55), 0 0 0 1px rgb(var(--c-line) / 0.9)',
        glow: '0 0 0 1px rgb(var(--c-accent) / 0.35), 0 8px 32px -8px rgb(var(--c-accent) / 0.35)',
      },
      animation: {
        'fade-in': 'fadeIn 140ms ease-out',
        'scale-in': 'scaleIn 140ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-right': 'slideRight 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s linear infinite',
        spin: 'spin 900ms linear infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.97) translateY(-4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideRight: {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          from: { backgroundPosition: '-200% 0' },
          to: { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
