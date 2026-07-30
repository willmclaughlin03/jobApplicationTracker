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
 * @param {React.ReactNode} [props.filters] - Responsive Filters region.
 * @param {boolean} [props.filtersExpanded] - Whether the wide Filters track is released.
 * @param {React.ReactNode} props.children - Flexible dashboard workspace.
 * @returns {React.ReactElement} Scoped responsive dashboard shell.
 */
export default function DashboardShell({
  navigation = null,
  filters = null,
  filtersExpanded = true,
  children,
}) {
  const hasNavigation = navigation != null;
  const hasFilters = filters != null;
  const outerColumnClasses = hasNavigation
    ? 'lg:grid-cols-[var(--dash-rail-compact)_minmax(0,1fr)] wide:grid-cols-[var(--dash-rail-wide)_minmax(0,1fr)]'
    : 'grid-cols-[minmax(0,1fr)]';
  const contentColumnClasses = hasFilters
    ? (
      filtersExpanded
        ? 'wide:grid-cols-[var(--dash-filters-wide)_minmax(0,1fr)] wide:gap-x-3'
        : 'wide:grid-cols-[0_minmax(0,1fr)] wide:gap-x-0'
    )
    : 'grid-cols-[minmax(0,1fr)]';

  return (
    <div className={[dashboardFont.variable, 'dashboard-root', 'font-dashboard'].join(' ')}>
      <div
        className={[
          'relative z-10 grid min-h-screen min-w-0 grid-cols-[minmax(0,1fr)] lg:gap-x-3',
          outerColumnClasses,
        ].join(' ')}
      >
        {hasNavigation && (
          <div className="min-w-0 lg:min-h-screen">
            {navigation}
          </div>
        )}

        <div
          data-filters-expanded={hasFilters ? String(filtersExpanded) : undefined}
          className={[
            'dashboard-motion grid min-w-0 grid-cols-[minmax(0,1fr)] transition-[grid-template-columns,column-gap]',
            contentColumnClasses,
          ].join(' ')}
        >
          {hasFilters && (
            <div className="contents wide:block wide:min-w-0 wide:overflow-hidden">
              {filters}
            </div>
          )}

          <div className="min-w-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
