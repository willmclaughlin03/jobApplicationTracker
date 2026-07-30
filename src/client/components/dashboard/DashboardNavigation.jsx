import {
  BriefcaseBusiness,
  CalendarDays,
  CreditCard,
  ListFilter,
} from 'lucide-react';
import Link from 'next/link';

/**
 * Render the authenticated dashboard's real navigation and billing entry.
 *
 * Purpose: Centralizes the TrackTheApp wordmark and approved Applications,
 * Filters, Activity, and billing controls without taking ownership of their
 * state or decisions. The page keeps filter, overlay, and billing behavior and
 * passes only the settled presentation contract into this rail.
 *
 * @param {object} props - Navigation state and callbacks owned by Dashboard.
 * @param {boolean} props.filtersOpen - Whether the active Filters panel is open.
 * @param {boolean} props.hasActiveFilters - Whether status/search/salary filters are active.
 * @param {Function} props.onFiltersToggle - Toggles the active responsive Filters mode.
 * @param {React.RefObject} props.filtersTriggerRef - Stable focus-return target.
 * @param {boolean} props.activityOpen - Whether the Activity drawer is open.
 * @param {boolean} props.hasSelectedDates - Whether Activity dates are selected.
 * @param {Function} props.onActivityToggle - Toggles the Activity drawer.
 * @param {boolean} props.billingEntryLoading - Whether the initial billing entry is unresolved.
 * @param {string} props.billingLabel - Canonical Upgrade, Manage plan, or Billing label.
 * @param {boolean} props.billingOpensDialog - Whether the billing entry opens the upgrade dialog.
 * @param {boolean} props.billingDialogOpen - Whether the upgrade dialog is open.
 * @param {Function} props.onBillingEntry - Executes the page-owned billing action.
 * @returns {React.ReactElement} Responsive dashboard navigation.
 */
export default function DashboardNavigation({
  filtersOpen,
  hasActiveFilters,
  onFiltersToggle,
  filtersTriggerRef,
  activityOpen,
  hasSelectedDates,
  onActivityToggle,
  billingEntryLoading,
  billingLabel,
  billingOpensDialog,
  billingDialogOpen,
  onBillingEntry,
}) {
  return (
    <nav
      aria-label="Dashboard"
      className="dashboard-major-panel flex min-w-0 flex-col rounded-none border-x-0 border-t-0 bg-dashboard-rail/95 p-3 text-dashboard-text lg:sticky lg:top-0 lg:h-screen lg:rounded-none lg:border-b-0 lg:border-l-0 lg:border-r"
    >
      <Link
        href="/"
        aria-label="TrackTheApp home"
        className="dashboard-focus-ring inline-flex min-h-9 items-center rounded-dashboard-control px-2 text-lg font-semibold tracking-tight text-dashboard-text lg:justify-center lg:px-0 wide:justify-start wide:px-2"
      >
        <span className="lg:hidden wide:inline">TrackTheApp</span>
        <span className="hidden text-xs [writing-mode:vertical-rl] lg:inline wide:hidden">
          TrackTheApp
        </span>
      </Link>

      <div className="mt-3 flex min-w-0 flex-wrap gap-2 lg:flex-col">
        <Link
          href="/"
          aria-current="page"
          className="dashboard-focus-ring inline-flex min-h-9 items-center gap-2 rounded-dashboard-control border border-dashboard-accent/60 bg-dashboard-active px-3 py-2 text-dashboard-body font-medium text-dashboard-text lg:justify-center lg:px-2 wide:justify-start wide:px-3"
        >
          <BriefcaseBusiness aria-hidden="true" size={18} strokeWidth={1.8} />
          <span className="lg:sr-only wide:not-sr-only">Applications</span>
        </Link>

        <button
          ref={filtersTriggerRef}
          id="dashboard-filters-trigger"
          type="button"
          onClick={onFiltersToggle}
          aria-expanded={filtersOpen}
          aria-controls="dashboard-filters-panel"
          className={[
            'dashboard-focus-ring relative inline-flex min-h-9 items-center gap-2 rounded-dashboard-control border px-3 py-2 text-dashboard-body font-medium transition-colors lg:justify-center lg:px-2 wide:justify-start wide:px-3',
            filtersOpen
              ? 'border-dashboard-accent/60 bg-dashboard-active text-dashboard-text'
              : 'border-transparent text-dashboard-muted hover:border-dashboard-control-border hover:bg-dashboard-surface-hover hover:text-dashboard-text',
          ].join(' ')}
        >
          <ListFilter aria-hidden="true" size={18} strokeWidth={1.8} />
          <span className="lg:sr-only wide:not-sr-only">Filters</span>
          {hasActiveFilters && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-dashboard-accent wide:right-2"
            />
          )}
        </button>

        <button
          id="dashboard-activity-trigger"
          type="button"
          onClick={onActivityToggle}
          aria-expanded={activityOpen}
          aria-controls="dashboard-activity-drawer"
          className={[
            'dashboard-focus-ring relative inline-flex min-h-9 items-center gap-2 rounded-dashboard-control border px-3 py-2 text-dashboard-body font-medium transition-colors lg:justify-center lg:px-2 wide:justify-start wide:px-3',
            activityOpen
              ? 'border-dashboard-accent/60 bg-dashboard-active text-dashboard-text'
              : 'border-transparent text-dashboard-muted hover:border-dashboard-control-border hover:bg-dashboard-surface-hover hover:text-dashboard-text',
          ].join(' ')}
        >
          <CalendarDays aria-hidden="true" size={18} strokeWidth={1.8} />
          <span className="lg:sr-only wide:not-sr-only">Activity</span>
          {hasSelectedDates && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-dashboard-accent wide:right-2"
            />
          )}
        </button>
      </div>

      <div className="ml-auto mt-3 lg:ml-0 lg:mt-auto">
        {billingEntryLoading ? (
          <div
            data-testid="billing-entry-skeleton"
            role="status"
            aria-label="Loading plan options"
            className="h-10 w-28 animate-pulse rounded-dashboard-control border border-dashboard-line bg-dashboard-surface-raised lg:w-full"
          />
        ) : (
          <button
            type="button"
            onClick={onBillingEntry}
            aria-haspopup={billingOpensDialog ? 'dialog' : undefined}
            aria-expanded={billingOpensDialog ? billingDialogOpen : undefined}
            className="dashboard-focus-ring inline-flex min-h-9 w-full items-center gap-2 rounded-dashboard-control border border-dashboard-control-border bg-dashboard-surface-raised/90 px-3 py-2 text-dashboard-body font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover lg:justify-center lg:px-2 wide:justify-start wide:px-3"
          >
            <CreditCard aria-hidden="true" size={18} strokeWidth={1.8} />
            <span className="lg:sr-only wide:not-sr-only">{billingLabel}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
