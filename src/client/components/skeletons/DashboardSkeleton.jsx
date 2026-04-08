import Skeleton from './Skeleton.jsx';

/**
 * Full-page loading skeleton for the dashboard.
 *
 * Purpose: Renders during the initial auth gate (authLoading) on the dashboard
 * so users see the page shell filling in instead of a blank screen + spinner.
 * Mirrors the real layout in src/pages/index.js so there's no layout shift
 * when the real UI mounts.
 *
 * Flicker prevention: The shell uses the `skeleton-in` animation defined in
 * tailwind.config.js, which delays fade-in by 150ms. Fast auth resolutions
 * never flash the skeleton — the user sees a brief blank bg-gray-100 instead,
 * which is less jarring than a sub-100ms pulse flash.
 *
 * Connects to: src/pages/index.js (authLoading branch)
 * Counterpart: JobTable.jsx / JobTableRow.jsx / JobCardMobile.jsx — column
 * widths and card layout are mirrored from those components.
 */
export default function DashboardSkeleton() {
  const SKELETON_ROWS = 6;
  const SKELETON_CARDS = 4;

  return (
    <div className="min-h-screen bg-gray-100 animate-skeleton-in">
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading dashboard</span>

        {/* Header — matches src/pages/index.js:112-117 */}
        <header className="bg-white shadow-sm py-4 px-6">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <h1 className="text-xl font-semibold text-gray-800">Track The App</h1>
            {/* ProfileDropdown avatar placeholder */}
            <Skeleton className="w-9 h-9 rounded-full" />
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-6">
          {/* Button row — matches src/pages/index.js:147-193 */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              {/* Filters, Activity, Resume buttons */}
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
            </div>
            <div className="flex items-center gap-3">
              {/* Add New Job button */}
              <Skeleton className="h-10 w-32" />
            </div>
          </div>

          {/* Desktop table shell — matches JobTable.jsx */}
          <div className="hidden md:block bg-white rounded-lg overflow-hidden shadow-sm">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Company</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Position</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Salary</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Notes</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-200 last:border-b-0" data-testid="skeleton-row">
                    <td className="px-4 py-3 max-w-[9rem]">
                      <Skeleton className="h-4 w-28" />
                    </td>
                    <td className="px-4 py-3 max-w-[9rem]">
                      <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-6 w-20 rounded-full" />
                      <Skeleton className="h-3 w-12 mt-1" />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Skeleton className="h-4 w-20" />
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <Skeleton className="h-4 w-full" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <Skeleton className="h-7 w-12" />
                        <Skeleton className="h-7 w-14" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card shell — matches JobCardMobile.jsx */}
          <div className="md:hidden space-y-3">
            {Array.from({ length: SKELETON_CARDS }).map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3"
                data-testid="skeleton-card"
              >
                {/* Header: company + status pill */}
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-6 w-20 rounded-full shrink-0" />
                </div>
                {/* Position */}
                <Skeleton className="h-4 w-40" />
                {/* Salary + date */}
                <div className="flex items-center gap-3">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                {/* Action buttons */}
                <div className="flex gap-2 pt-2 border-t border-gray-100">
                  <Skeleton className="h-8 flex-1" />
                  <Skeleton className="h-8 flex-1" />
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* Footer — rendered outside role="status" so the attribution link
          isn't announced as part of the loading state. Copied verbatim
          from src/pages/index.js:268-270 so it stays put across the
          skeleton → real-page transition. */}
      <footer className="text-center text-xs text-gray-400 py-4">
        <a target="_blank" rel="noopener noreferrer" href="https://icons8.com/icon/hH1yYj2eECWj/job" className="hover:text-gray-500">Icon</a> by <a target="_blank" rel="noopener noreferrer" href="https://icons8.com" className="hover:text-gray-500">Icons8</a>
      </footer>
    </div>
  );
}
