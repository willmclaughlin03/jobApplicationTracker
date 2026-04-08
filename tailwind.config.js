/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx}',
    './src/client/components/**/*.{js,ts,jsx,tsx}',
    './src/shared/constants/**/*.{js,ts}',
  ],
  theme: {
    extend: {
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
