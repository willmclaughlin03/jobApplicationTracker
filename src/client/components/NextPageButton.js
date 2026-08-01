import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Normalize an unknown count-like value into a non-negative integer.
 *
 * Purpose: pagination copy must never expose NaN, negative, or fractional
 * ranges if a malformed presentation prop reaches the component.
 *
 * @param {unknown} value - Raw count-like input.
 * @returns {number} Safe non-negative integer.
 */
function toNonNegativeInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Build the centered five-button page window for a fixed result count.
 *
 * @param {number} currentPage - Clamped active page.
 * @param {number} totalPages - Safe positive total page count.
 * @returns {number[]} Ordered visible page numbers.
 */
function getVisiblePages(currentPage, totalPages) {
  const maxButtons = 5;

  if (totalPages <= maxButtons) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  let start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + maxButtons - 1);

  if (end - start < maxButtons - 1) {
    start = Math.max(1, end - maxButtons + 1);
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/**
 * Render fixed-size application pagination with an accurate result range.
 *
 * Purpose: preserves the existing page-change callback and ten-row contract
 * while adding defensive first, middle, final, partial, and zero-result copy.
 *
 * @param {object} props - Pagination presentation contract.
 * @param {number} props.currentPage - Existing one-based current page.
 * @param {number} props.totalCount - Total filtered application count.
 * @param {number} props.pageSize - Existing fixed page size of ten.
 * @param {Function} props.onPageChange - Existing page navigation callback.
 * @returns {React.ReactElement} Count copy and page controls when needed.
 */
export default function NextPageButton({ currentPage, totalCount, pageSize, onPageChange }) {
  const safeTotalCount = toNonNegativeInteger(totalCount);
  const safePageSize = toNonNegativeInteger(pageSize) || 10;
  const totalPages = Math.max(1, Math.ceil(safeTotalCount / safePageSize));
  const requestedPage = toNonNegativeInteger(currentPage) || 1;
  const safeCurrentPage = Math.min(requestedPage, totalPages);
  const rangeStart = safeTotalCount === 0
    ? 0
    : ((safeCurrentPage - 1) * safePageSize) + 1;
  const rangeEnd = safeTotalCount === 0
    ? 0
    : Math.min(safeCurrentPage * safePageSize, safeTotalCount);
  const visiblePages = getVisiblePages(safeCurrentPage, totalPages);

  return (
    <nav
      aria-label="Applications pagination"
      className="dashboard-major-panel mt-4 flex flex-col gap-3 rounded-dashboard-panel bg-dashboard-surface px-4 py-3 text-dashboard-body text-dashboard-muted sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="tabular-nums" aria-live="polite">
        Showing <span className="font-medium text-dashboard-text">{rangeStart}-{rangeEnd}</span>
        {' '}of <span className="font-medium text-dashboard-text">{safeTotalCount}</span> applications
      </p>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Application pages">
          <button
            type="button"
            onClick={() => onPageChange(safeCurrentPage - 1)}
            disabled={safeCurrentPage === 1}
            aria-label="Previous page"
            className="dashboard-control dashboard-focus-ring inline-flex min-h-9 items-center gap-1 px-2.5 py-1.5 font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft aria-hidden="true" size={16} />
            <span className="sr-only sm:not-sr-only">Previous</span>
          </button>

          {visiblePages.map((page) => (
            <button
              type="button"
              key={page}
              onClick={() => onPageChange(page)}
              aria-label={`Page ${page}`}
              aria-current={page === safeCurrentPage ? 'page' : undefined}
              className={`dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center rounded-dashboard-control border px-2 py-1.5 font-medium tabular-nums transition-colors ${
                page === safeCurrentPage
                  ? 'border-dashboard-accent bg-dashboard-accent text-dashboard-accent-ink'
                  : 'border-dashboard-control-border bg-dashboard-surface-raised text-dashboard-text hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover'
              }`}
            >
              {page}
            </button>
          ))}

          <button
            type="button"
            onClick={() => onPageChange(safeCurrentPage + 1)}
            disabled={safeCurrentPage === totalPages}
            aria-label="Next page"
            className="dashboard-control dashboard-focus-ring inline-flex min-h-9 items-center gap-1 px-2.5 py-1.5 font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="sr-only sm:not-sr-only">Next</span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </div>
      )}
    </nav>
  );
}
