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

export const PUBLIC_SECONDARY_ACTION_CLASS_NAME = [
  'dashboard-focus-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-dashboard-control',
  'border border-dashboard-line bg-dashboard-surface/45 px-3.5 py-2.5',
  'text-dashboard-caption font-medium text-dashboard-muted transition-colors',
  'hover:border-dashboard-accent/50 hover:bg-dashboard-surface-raised/65 hover:text-dashboard-text',
  'disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-12 sm:px-4 sm:py-3 sm:text-dashboard-body',
].join(' ');

/**
 * Render the shared emerald atmosphere, branding, and responsive content rail.
 *
 * Purpose: Keeps login, billing, and full-page errors on one visual foundation.
 * The billing layout accommodates account controls and longer scrolling content
 * without changing the default centered login and error-page composition.
 *
 * @param {object} props - Shared shell presentation props.
 * @param {React.ReactNode} props.children - Route-specific main content.
 * @param {'compact'|'billing'} [props.layout] - Centered compact or wider billing layout.
 * @param {React.ReactNode} [props.headerActions] - Optional account controls beside the brand.
 * @param {string} [props.contentClassName] - Additional main-content classes.
 * @param {string} [props.contentTestId] - Optional stable test identifier for main content.
 * @returns {React.ReactElement} Full-viewport branded public-page shell.
 */
export default function PublicPageShell({
  children,
  layout = 'compact',
  headerActions,
  contentClassName = '',
  contentTestId,
}) {
  return (
    <div className={[publicPageFont.variable, 'public-page-root', 'font-dashboard'].join(' ')}>
      <div className="public-page-frame">
        <PublicDottedWave />

        <div className="relative z-10 flex min-h-[100dvh] w-full flex-col px-4 py-6 sm:px-8 sm:py-8">
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div
              data-testid="public-page-brand"
              className="flex shrink-0 items-center gap-2 text-dashboard-caption font-semibold tracking-tight text-dashboard-text"
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-[0.2rem] border border-dashboard-accent/70 text-dashboard-accent">
                <ChartNoAxesCombined aria-hidden="true" size={11} strokeWidth={1.7} />
              </span>
              <span>TrackTheApp</span>
            </div>
            {headerActions && (
              <div className="min-w-0 max-w-full sm:max-w-64">{headerActions}</div>
            )}
          </header>

          <main
            data-testid={contentTestId}
            className={[
              'public-page-panel mx-auto w-full min-w-0 flex-1',
              layout === 'billing'
                ? 'max-w-4xl pb-24 pt-12 sm:pb-32 sm:pt-16'
                : 'max-w-lg pt-20 sm:flex sm:flex-col sm:justify-center sm:pb-24 sm:pt-0',
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
