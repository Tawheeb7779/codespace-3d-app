/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Deep Space palette
        background: '#0e131d',
        surface: {
          DEFAULT: '#0e131d',
          dim: '#0e131d',
          bright: '#343944',
          variant: '#303540',
          lowest: '#090e18',
          low: '#171c26',
          DEFAULT2: '#1b202a',
          high: '#252a35',
          highest: '#303540',
        },
        'on-surface': {
          DEFAULT: '#dee2f1',
          variant: '#c2c6d6',
        },
        outline: {
          DEFAULT: '#8c909f',
          variant: '#424754',
        },
        primary: {
          DEFAULT: '#adc6ff',
          container: '#4d8eff',
          fixed: '#d8e2ff',
          'fixed-dim': '#adc6ff',
        },
        'on-primary': {
          DEFAULT: '#002e6a',
          container: '#00285d',
          fixed: '#001a42',
        },
        secondary: {
          DEFAULT: '#a4c9ff',
          container: '#0267b8',
          fixed: '#d4e3ff',
          'fixed-dim': '#a4c9ff',
        },
        'on-secondary': {
          DEFAULT: '#00315d',
          container: '#d6e5ff',
        },
        tertiary: {
          DEFAULT: '#ffb786',
          container: '#df7412',
          fixed: '#ffdcc6',
          'fixed-dim': '#ffb786',
        },
        'on-tertiary': {
          DEFAULT: '#502400',
          container: '#461f00',
        },
        error: {
          DEFAULT: '#ffb4ab',
          container: '#93000a',
        },
        'on-error': {
          DEFAULT: '#690005',
          container: '#ffdad6',
        },
        success: '#4ade80',
        warning: '#fbbf24',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-md': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'body-lg': ['18px', { lineHeight: '28px', fontWeight: '400' }],
        'body-md': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'code-sm': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'label-caps': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
      spacing: {
        gutter: '20px',
        unit: '4px',
        'container-max': '1440px',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-in': 'slideIn 0.25s ease-out',
        'slide-up': 'slideUp 0.25s ease-out',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 8px 0px rgba(173, 198, 255, 0.4)' },
          '50%': { boxShadow: '0 0 16px 2px rgba(173, 198, 255, 0.6)' },
        },
      },
    },
  },
  plugins: [],
};
