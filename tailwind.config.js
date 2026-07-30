/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx}',
    './src/client/components/**/*.{js,ts,jsx,tsx}',
    './src/shared/constants/**/*.{js,ts}',
  ],
  theme: {
    extend: {
      screens: {
        wide: '1400px',
      },
      colors: {
        dashboard: {
          canvas: 'rgb(var(--dash-canvas) / <alpha-value>)',
          rail: 'rgb(var(--dash-rail) / <alpha-value>)',
          surface: 'rgb(var(--dash-surface) / <alpha-value>)',
          'surface-raised': 'rgb(var(--dash-surface-raised) / <alpha-value>)',
          'surface-hover': 'rgb(var(--dash-surface-hover) / <alpha-value>)',
          text: 'rgb(var(--dash-text) / <alpha-value>)',
          muted: 'rgb(var(--dash-muted) / <alpha-value>)',
          line: 'rgb(var(--dash-line) / <alpha-value>)',
          accent: 'rgb(var(--dash-accent) / <alpha-value>)',
          'accent-hover': 'rgb(var(--dash-accent-hover) / <alpha-value>)',
          'accent-ink': 'rgb(var(--dash-accent-ink) / <alpha-value>)',
          active: 'var(--dash-active-fill)',
          'panel-border': 'var(--dash-panel-border)',
          'control-border': 'var(--dash-control-border)',
          'focus-ring': 'var(--dash-focus-ring)',
        },
      },
      fontFamily: {
        dashboard: [
          'var(--font-dashboard)',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
      fontSize: {
        'dashboard-caption': [
          'var(--dash-font-size-caption)',
          { lineHeight: 'var(--dash-line-height-caption)' },
        ],
        'dashboard-body': [
          'var(--dash-font-size-body)',
          { lineHeight: 'var(--dash-line-height-body)' },
        ],
        'dashboard-heading': [
          'var(--dash-font-size-heading)',
          { lineHeight: 'var(--dash-line-height-heading)' },
        ],
      },
      borderRadius: {
        'dashboard-control': 'var(--dash-radius-control)',
        'dashboard-panel': 'var(--dash-radius-panel)',
      },
      boxShadow: {
        'dashboard-panel': 'var(--dash-panel-glow)',
      },
      transitionDuration: {
        dashboard: 'var(--dash-motion-duration)',
      },
      transitionTimingFunction: {
        dashboard: 'var(--dash-motion-easing)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        // Delayed fade-in prevents skeleton flicker on fast auth resolutions (<150ms)
        'skeleton-in': 'fadeIn 0.2s ease-in 0.15s forwards',
      },
    },
  },
  plugins: [],
}
