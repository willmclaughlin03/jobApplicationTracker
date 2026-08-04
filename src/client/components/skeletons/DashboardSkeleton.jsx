import DashboardShell from '../dashboard/DashboardShell.jsx';
import Skeleton from './Skeleton.jsx';

const SKELETON_ROWS = 6;
const SKELETON_CARDS = 4;

/**
 * Render the initial authenticated-dashboard loading state.
 *
 * Purpose: mirrors the settled rail, wide Filters track, toolbar, responsive
 * results, pagination, billing entry, and footer geometry while authentication
 * resolves. The visual scaffold is decorative and non-interactive; one concise
 * status message is the only content exposed to assistive technology.
 *
 * Connects to: src/pages/index.js (authLoading branch) and DashboardShell.jsx.
 * Counterparts: DashboardNavigation, JobStatsSidebar, DashboardToolbar,
 * JobTable, JobCardMobile, and NextPageButton.
 *
 * @returns {React.ReactElement} Responsive emerald dashboard loading shell.
 */
export default function DashboardSkeleton() {
  const navigationSkeleton = (
    <div
      data-testid="skeleton-navigation"
      className="dashboard-major-panel flex min-w-0 flex-col rounded-none border-x-0 border-t-0 bg-dashboard-rail/95 p-3 lg:h-screen lg:rounded-none lg:border-b-0 lg:border-l-0 lg:border-r"
    >
      <Skeleton className="h-5 w-28 lg:hidden wide:block" />
      <Skeleton className="hidden h-24 w-3 lg:block wide:hidden" />

      <div className="mt-3 flex min-w-0 flex-wrap gap-2 lg:flex-col">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-28 lg:w-full" />
        ))}
      </div>

      <div className="ml-auto mt-3 lg:ml-0 lg:mt-auto">
        <div
          data-testid="billing-entry-skeleton"
          className="h-10 w-28 rounded-dashboard-control border border-dashboard-line bg-dashboard-surface-raised lg:w-full"
        >
          <Skeleton className="h-full w-full rounded-dashboard-control" />
        </div>
      </div>
    </div>
  );
  const filtersSkeleton = (
    <div
      data-testid="skeleton-filters"
      className="dashboard-major-panel relative hidden h-full min-h-screen w-[var(--dash-filters-wide)] flex-col overflow-hidden bg-dashboard-surface/95 text-dashboard-text wide:flex"
    >
      <div className="flex items-center justify-between border-b border-dashboard-line px-4 py-3">
        <div className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-9 w-9" />
      </div>

      <div className="space-y-3 border-b border-dashboard-line px-4 py-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mx-auto h-32 w-32 rounded-full" />
      </div>

      <div className="space-y-2 border-b border-dashboard-line p-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>

      <div className="space-y-2 border-b border-dashboard-line px-4 py-3">
        <Skeleton className="h-3 w-24" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        Loading dashboard
      </div>

      <div
        data-testid="dashboard-skeleton-visual"
        aria-hidden="true"
        className="animate-skeleton-in"
      >
        <DashboardShell
          navigation={navigationSkeleton}
          filters={filtersSkeleton}
          filtersExpanded
        >
          <main className="min-w-0 px-3 py-4 sm:px-4 lg:px-5 wide:px-6">
            <section
              data-testid="skeleton-toolbar"
              className="dashboard-major-panel rounded-dashboard-panel bg-dashboard-surface/90 px-4 py-4 sm:px-5"
            >
              <div className="flex flex-col gap-4">
                <div className="space-y-2">
                  <Skeleton className="h-8 w-44 sm:h-9" />
                  <Skeleton className="h-4 w-64 max-w-full" />
                </div>

                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <Skeleton className="h-9 min-w-0 flex-1" />
                  <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
                    <Skeleton className="h-9 w-36 max-w-full" />
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <Skeleton className="h-9 w-36 flex-1 sm:flex-none" />
                  </div>
                </div>
              </div>
            </section>

            <div className="mt-4">
              <div className="dashboard-major-panel hidden overflow-hidden rounded-dashboard-panel bg-dashboard-surface lg:block">
                <table className="w-full table-fixed border-collapse">
                  <colgroup>
                    <col className="w-[27%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                    <col className="w-[15%]" />
                    <col className="w-[20%]" />
                    <col className="w-[8%]" />
                  </colgroup>
                  <thead className="bg-dashboard-surface-raised">
                    <tr className="border-b border-dashboard-line">
                      {Array.from({ length: 6 }).map((_, index) => (
                        <th key={index} className="px-3 py-3">
                          <Skeleton className="h-3 w-full max-w-20" />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: SKELETON_ROWS }).map((_, rowIndex) => (
                      <tr
                        key={rowIndex}
                        data-testid="skeleton-row"
                        className="border-b border-dashboard-line last:border-b-0"
                      >
                        <td className="space-y-2 px-3 py-3">
                          <Skeleton className="h-4 w-4/5" />
                          <Skeleton className="h-3 w-3/5" />
                        </td>
                        <td className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>
                        <td className="space-y-2 px-3 py-3">
                          <Skeleton className="h-7 w-full rounded-full" />
                          <Skeleton className="h-3 w-3/5" />
                        </td>
                        <td className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>
                        <td className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>
                        <td className="px-3 py-3"><Skeleton className="ml-auto h-9 w-9" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 lg:hidden">
                {Array.from({ length: SKELETON_CARDS }).map((_, index) => (
                  <article
                    key={index}
                    data-testid="skeleton-card"
                    className="dashboard-major-panel space-y-3 rounded-dashboard-panel bg-dashboard-surface p-4"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Skeleton className="h-4 w-4/5" />
                        <Skeleton className="h-4 w-3/5" />
                      </div>
                      <Skeleton className="h-7 w-20 shrink-0 rounded-full" />
                    </div>
                    <div className="grid grid-cols-1 gap-2 border-y border-dashboard-line py-3 sm:grid-cols-2">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <Skeleton className="h-10 w-full" />
                    <div className="grid grid-cols-2 gap-2 border-t border-dashboard-line pt-3">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  </article>
                ))}
              </div>

              <div
                data-testid="skeleton-pagination"
                className="dashboard-major-panel mt-4 flex flex-col gap-3 rounded-dashboard-panel bg-dashboard-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <Skeleton className="h-4 w-48 max-w-full" />
                <div className="flex gap-1.5">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-9 w-9" />
                  ))}
                </div>
              </div>
            </div>
          </main>

          <footer className="flex justify-center py-4">
            <Skeleton className="h-3 w-24" />
          </footer>
        </DashboardShell>
      </div>
    </>
  );
}
