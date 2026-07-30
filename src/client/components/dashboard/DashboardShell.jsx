import { Inter } from 'next/font/google';

const dashboardFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dashboard',
});

/**
 * Provide the dashboard-only visual root and responsive application geometry.
 *
 * Purpose: Keeps the Inter font, emerald atmosphere, and future navigation and
 * Filters columns scoped to the authenticated dashboard while leaving data,
 * disclosure state, and workflows in the page. Optional slots let later
 * chunks add real regions without reserving empty columns in this foundation.
 *
 * @param {object} props - Presentational dashboard regions.
 * @param {React.ReactNode} [props.navigation] - Product navigation region.
 * @param {React.ReactNode} [props.filters] - Wide docked Filters region.
 * @param {React.ReactNode} props.children - Flexible dashboard workspace.
 * @returns {React.ReactElement} Scoped responsive dashboard shell.
 */
export default function DashboardShell({
  navigation = null,
  filters = null,
  children,
}) {
  const hasNavigation = navigation != null;
  const hasFilters = filters != null;
  const columnClasses = hasNavigation
    ? (
      hasFilters
        ? 'lg:grid-cols-[var(--dash-rail-compact)_minmax(0,1fr)] wide:grid-cols-[var(--dash-rail-wide)_var(--dash-filters-wide)_minmax(0,1fr)]'
        : 'lg:grid-cols-[var(--dash-rail-compact)_minmax(0,1fr)] wide:grid-cols-[var(--dash-rail-wide)_minmax(0,1fr)]'
    )
    : (
      hasFilters
        ? 'wide:grid-cols-[var(--dash-filters-wide)_minmax(0,1fr)]'
        : 'grid-cols-[minmax(0,1fr)]'
    );

  return (
    <div className={[dashboardFont.variable, 'dashboard-root', 'font-dashboard'].join(' ')}>
      <div
        className={[
          'relative z-10 grid min-h-screen min-w-0 grid-cols-[minmax(0,1fr)] wide:gap-3',
          columnClasses,
        ].join(' ')}
      >
        {hasNavigation && (
          <div className="min-w-0 lg:min-h-screen">
            {navigation}
          </div>
        )}

        {hasFilters && (
          <div className="hidden min-w-0 wide:block wide:min-h-screen">
            {filters}
          </div>
        )}

        <div className="min-w-0">
          {children}
        </div>
      </div>
    </div>
  );
}
