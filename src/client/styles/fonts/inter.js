import localFont from 'next/font/local';

/**
 * Share repository-local Inter between the dashboard and public page shells.
 * The literal asset path lets Next bundle the font without build-time fetching;
 * the variable preserves both shells' existing Tailwind font-dashboard contract.
 * Asset identity, coverage and license location are recorded in README.md.
 */
export const inter = localFont({
  src: './InterVariable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: true,
  adjustFontFallback: 'Arial',
  variable: '--font-dashboard',
});
