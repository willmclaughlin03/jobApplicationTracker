import { Inter } from 'next/font/google';
import { ChartNoAxesCombined } from 'lucide-react';
import PublicDottedWave from './PublicDottedWave';

const publicPageFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dashboard',
});

export const PUBLIC_PRIMARY_ACTION_CLASS_NAME = [
  'dashboard-focus-ring inline-flex min-h-11 w-full items-center rounded-dashboard-control',
  'border border-dashboard-accent/60 bg-dashboard-surface/45 px-3.5 py-2.5',
  'text-dashboard-caption font-medium text-dashboard-text shadow-dashboard-panel',
  'transition-[background-color,border-color,box-shadow,opacity] duration-dashboard ease-dashboard',
  'hover:border-dashboard-accent-hover/80 hover:bg-dashboard-surface-raised/65',
  'hover:shadow-[0_0_24px_rgb(var(--dash-accent)/0.16)]',
  'disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-12 sm:px-4 sm:py-3 sm:text-dashboard-body',
].join(' ');

/**
 * Render the shared public-page atmosphere, branding, and centered content rail.
 *
 * Purpose: Keeps login and full-page errors on one exact visual implementation
 * while allowing each route to supply its own accessible main content.
 *
 * @param {object} props - Shared shell presentation props.
 * @param {React.ReactNode} props.children - Route-specific main content.
 * @param {string} [props.contentClassName] - Additional main-content classes.
 * @param {string} [props.contentTestId] - Optional stable test identifier for main content.
 * @returns {React.ReactElement} Full-viewport branded public-page shell.
 */
export default function PublicPageShell({
  children,
  contentClassName = '',
  contentTestId,
}) {
  return (
    <div className={[publicPageFont.variable, 'public-page-root', 'font-dashboard'].join(' ')}>
      <div className="public-page-frame">
        <PublicDottedWave />

        <div className="relative z-10 flex min-h-[100dvh] w-full flex-col px-4 py-6 sm:px-8 sm:py-8">
          <header
            data-testid="public-page-brand"
            className="flex items-center gap-2 text-dashboard-caption font-semibold tracking-tight text-dashboard-text"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-[0.2rem] border border-dashboard-accent/70 text-dashboard-accent">
              <ChartNoAxesCombined aria-hidden="true" size={11} strokeWidth={1.7} />
            </span>
            <span>TrackTheApp</span>
          </header>

          <main
            data-testid={contentTestId}
            className={[
              'public-page-panel mx-auto w-full max-w-lg flex-1 pt-20',
              'sm:flex sm:flex-col sm:justify-center sm:pb-24 sm:pt-0',
              contentClassName,
            ].filter(Boolean).join(' ')}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
