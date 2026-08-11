import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../client/contexts/AuthContext';
import { useJobs } from '../client/hooks/useJobs';
import { useJobFormModal } from '../client/hooks/useJobFormModal';
import JobTable from '../client/components/JobTable';
import JobForm from '../client/components/JobForm';
import EditModal from '../client/components/EditModal';
import DeleteModal from '../client/components/DeleteModal';
import NextPageButton from '../client/components/NextPageButton';
import JobStatsSidebar from '../client/components/JobStatsSidebar';
import ProfileDropdown from '../client/components/ProfileDropdown';
import Spinner from '../client/components/Spinner';
import DashboardSkeleton from '../client/components/skeletons/DashboardSkeleton';
import DashboardShell from '../client/components/dashboard/DashboardShell';
import DashboardNavigation from '../client/components/dashboard/DashboardNavigation';
import DashboardToolbar from '../client/components/dashboard/DashboardToolbar';
import ActivityDrawer from '../client/components/ActivityDrawer';
import StorageDowngradeBanner from '../client/components/StorageDowngradeBanner';
import LockedArchivePanel from '../client/components/LockedArchivePanel';
import UpgradePlanModal from '../client/components/UpgradePlanModal';
import {
  DASHBOARD_BILLING_ENTRY_ACTIONS,
  getDashboardBillingEntryPoint,
} from '../client/lib/dashboardBillingEntryPoint.js';
import { PLAN_CATALOG } from '../client/lib/planCatalog.js';
import { getStorageCount } from '../client/lib/storageSummaryUi.js';
import { BILLING_PLANS } from '../shared/constants/billing.js';
import { STATUS_CONFIG } from '../shared/constants/statuses.js';

const PREMIUM_MONTHLY_PLAN = PLAN_CATALOG[BILLING_PLANS.PREMIUM_MONTHLY];
const DASHBOARD_WIDE_MEDIA_QUERY = '(min-width: 1400px)';

/**
 * Track the shell's locked wide breakpoint for responsive disclosure behavior.
 *
 * Purpose: one Filters trigger and one mounted panel need the same docked versus
 * drawer mode as the CSS shell. The server snapshot remains compact-safe, then
 * the media-query listener keeps resize transitions synchronized in the client.
 *
 * @returns {boolean} Whether the viewport currently uses the wide shell.
 */
function useDashboardWideLayout() {
  const [isWide, setIsWide] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(DASHBOARD_WIDE_MEDIA_QUERY);

    /**
     * Synchronize disclosure semantics with the live media query.
     *
     * @returns {void}
     */
    const syncWideLayout = () => setIsWide(mediaQuery.matches);

    syncWideLayout();
    mediaQuery.addEventListener('change', syncWideLayout);
    return () => mediaQuery.removeEventListener('change', syncWideLayout);
  }, []);

  return isWide;
}

/**
 * Gate private Dashboard work behind the current auth authority.
 *
 * Purpose: unavailable or transitional auth states must keep private hooks
 * unmounted, while only confirmed anonymous sessions redirect to login.
 *
 * @returns {JSX.Element|null} The loading shell, authenticated Dashboard, or no private UI.
 */
export default function Dashboard() {
  const {
    user,
    loading: authLoading,
    authStatus,
    canPerformUserWork,
    signOut,
  } = useAuth();
  const router = useRouter();

  if (authLoading) {
    return <DashboardSkeleton />;
  }

  if (authStatus === 'anonymous') {
    router.push('/login');
    return null;
  }

  if (authStatus !== 'authenticated' || !canPerformUserWork || !user) {
    return null;
  }

  return <PrivateDashboard user={user} signOut={signOut} router={router} />;
}

/**
 * Render authenticated Dashboard data and interaction state.
 *
 * Purpose: isolating private hooks in this child prevents unavailable sessions
 * from starting job work and resets private form state after auth recovery.
 *
 * @param {object} props - Authenticated Dashboard dependencies.
 * @param {object} props.user - Confirmed authenticated user.
 * @param {Function} props.signOut - Auth-context sign-out operation.
 * @param {object} props.router - Next.js router used by Dashboard actions.
 * @returns {JSX.Element} The authenticated Dashboard interface.
 */
function PrivateDashboard({ user, signOut, router }) {
  const isWideLayout = useDashboardWideLayout();
  const filtersTriggerRef = useRef(null);
  const addApplicationTriggerRef = useRef(null);
  const isAddFormActiveRef = useRef(false);
  const shouldRestoreAddFocusRef = useRef(false);
  const deleteInFlightRef = useRef(false);
  const [statusFilter, setStatusFilter] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResetKey, setSearchResetKey] = useState(0);
  const [salaryFilterMin, setSalaryFilterMin] = useState(null);
  const [salaryFilterMax, setSalaryFilterMax] = useState(null);
  const [selectedDates, setSelectedDates] = useState(new Set());
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  const handleDateToggle = (dateStr) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(dateStr)) {
        next.delete(dateStr);
      } else if (next.size < 7) {
        next.add(dateStr);
      }
      return next;
    });
  };

  const clearSelectedDates = () => setSelectedDates(new Set());

  const {
    jobs,
    allJobs,
    storageSummary,
    loading,
    saving,
    deleting,
    error,
    clearError,
    addJob,
    updateJob,
    deleteJob,
    refreshStorageSummary,
    currentPage,
    totalCount,
    totalJobs,
    statusCounts,
    pageSize,
    goToPage,
  } = useJobs(user?.id, statusFilter, searchQuery, salaryFilterMin, salaryFilterMax, selectedDates);

  const archivedCount = getStorageCount(storageSummary?.lockedCount);
  const dashboardBillingEntryLoading = loading && !storageSummary;
  const dashboardBillingEntryPoint = getDashboardBillingEntryPoint(storageSummary?.status);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [jobToDelete, setJobToDelete] = useState(null);

  useEffect(() => {
    if (isWideLayout && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [isWideLayout, sidebarOpen]);

  const {
    showForm,
    editingJob,
    toggleAddForm,
    closeAddForm,
    openEditForm,
    closeEditForm,
  } = useJobFormModal();
  const hasCompetingFocusOwner = Boolean(
    editingJob
    || jobToDelete
    || activityOpen
    || upgradeModalOpen
    || (!isWideLayout && sidebarOpen)
  );

  /**
   * Return focus after an explicit inline Add form close completes rendering.
   *
   * Purpose: successful submissions can resolve while the toolbar trigger is
   * still disabled, so the page waits for the closed, enabled render before
   * returning focus to the persistent Add Application control.
   *
   * @returns {void}
   */
  useEffect(() => {
    isAddFormActiveRef.current = showForm;

    if (hasCompetingFocusOwner) {
      shouldRestoreAddFocusRef.current = false;
      return;
    }

    if (!showForm && !saving && shouldRestoreAddFocusRef.current) {
      shouldRestoreAddFocusRef.current = false;
      addApplicationTriggerRef.current?.focus();
    }
  }, [showForm, saving, hasCompetingFocusOwner]);

  /**
   * Toggle the Filters disclosure that belongs to the current responsive mode.
   *
   * @returns {void}
   */
  const handleFiltersToggle = () => {
    if (isWideLayout) {
      setFiltersExpanded(previous => !previous);
      return;
    }
    setSidebarOpen(previous => !previous);
  };

  /**
   * Close Filters and return docked focus to the persistent navigation trigger.
   *
   * @returns {void}
   */
  const handleFiltersClose = () => {
    if (isWideLayout) {
      setFiltersExpanded(false);
      filtersTriggerRef.current?.focus();
      return;
    }
    setSidebarOpen(false);
  };

  /**
   * Clear every Filters-owned criterion and invalidate pending toolbar search.
   *
   * Purpose: preserves the single explicit Clear All path while ensuring a
   * pre-debounce company-search draft cannot restore stale filter state.
   *
   * @returns {void}
   */
  const handleClearAllFilters = () => {
    setStatusFilter(null);
    setSearchQuery('');
    setSalaryFilterMin(null);
    setSalaryFilterMax(null);
    setSearchResetKey(previous => previous + 1);
  };

  /**
   * Toggle the existing Activity drawer from its navigation disclosure.
   *
   * @returns {void}
   */
  const handleActivityToggle = () => {
    setActivityOpen(previous => !previous);
  };

  /**
   * Close the inline Add form and request focus return to its toolbar trigger.
   *
   * @returns {void}
   */
  const handleAddFormClose = () => {
    if (isAddFormActiveRef.current) {
      shouldRestoreAddFocusRef.current = true;
    }
    closeAddForm();
  };

  /**
   * Submit one application through the existing guarded mutation workflow.
   *
   * @param {object} jobData - Existing validated application payload.
   * @returns {Promise<void>} Resolves after the mutation result is handled.
   */
  const handleAddJob = async (jobData) => {
    const result = await addJob(jobData);
    if (result.success) handleAddFormClose();
  };

  const handleUpdateJob = async (id, updates) => {
    const result = await updateJob(id, updates);
    if (result.success) closeEditForm();
  };

  /**
   * Open the existing confirmation dialog for one visible application.
   *
   * @param {string} id - Visible application id selected from row/card actions.
   * @returns {void}
   */
  const handleDeleteJob = (id) => {
    const job = jobs.find(j => j.id === id);
    if (job) setJobToDelete(job);
  };

  /**
   * Confirm one guarded application deletion through the existing mutation.
   *
   * Purpose: close the synchronous duplicate-confirmation gap before the
   * deleting hook state can re-render the modal as disabled.
   *
   * @returns {Promise<void>} Resolves after the mutation settles or is skipped.
   */
  const confirmDeleteJob = async () => {
    if (!jobToDelete || deleting || deleteInFlightRef.current) {
      return;
    }

    deleteInFlightRef.current = true;
    try {
      const result = await deleteJob(jobToDelete.id);
      if (result.success) setJobToDelete(null);
    } finally {
      deleteInFlightRef.current = false;
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  /**
   * Close the idle Dashboard upgrade modal without changing routes.
   *
   * Purpose: provide the controlled modal with an explicit dismissal callback
   * while leaving Checkout-in-flight dismissal enforcement inside the modal.
   *
   * @returns {void}
   */
  const handleUpgradeModalClose = () => {
    setUpgradeModalOpen(false);
  };

  /**
   * Close the upgrade modal and open the canonical Billing page.
   *
   * Purpose: every non-Free, unavailable, or changed billing state retains a
   * safe recovery path without making the Dashboard interpret Checkout rules.
   *
   * @returns {void}
   */
  const handleBillingNavigation = () => {
    setUpgradeModalOpen(false);
    router.push('/billing');
  };

  /**
   * Recover an unauthorized modal session through the existing auth context.
   *
   * Purpose: expired billing requests must clear the modal, sign out local
   * state, and replace the protected Dashboard history entry with login.
   *
   * @returns {Promise<void>}
   */
  const handleBillingUnauthorized = async () => {
    setUpgradeModalOpen(false);
    await signOut();
    router.replace('/login');
  };

  /**
   * Execute the pure billing entry-point decision for the current summary.
   *
   * Purpose: only confirmed terminal Free opens the upgrade modal. All other
   * states route to Billing, and an existing focus-owning overlay prevents a
   * second modal from opening over the user's active work.
   *
   * @returns {void}
   */
  const handleDashboardBillingEntry = () => {
    if (
      dashboardBillingEntryPoint.action
      === DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL
    ) {
      const hasActiveOverlay = (!isWideLayout && sidebarOpen)
        || activityOpen
        || Boolean(editingJob)
        || Boolean(jobToDelete);

      if (!hasActiveOverlay) {
        setUpgradeModalOpen(true);
      }
      return;
    }

    handleBillingNavigation();
  };

  const filtersOpen = isWideLayout ? filtersExpanded : sidebarOpen;
  const hasActiveFilters = Boolean(
    statusFilter
    || searchQuery
    || salaryFilterMin != null
    || salaryFilterMax != null
  );
  // hasActiveFilters covers only Filters-panel criteria, so the panel indicator
  // ignores Activity-drawer dates. hasResultFilters adds selected dates because
  // dates also narrow the result set shown in the empty state.
  const hasResultFilters = Boolean(
    statusFilter
    || searchQuery
    || selectedDates.size > 0
    || salaryFilterMin != null
    || salaryFilterMax != null
  );
  const statusFilterLabel = STATUS_CONFIG[statusFilter]?.label ?? 'Selected status';
  const billingOpensDialog = dashboardBillingEntryPoint.action
    === DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL;

  return (
    <DashboardShell
      filtersExpanded={filtersExpanded}
      navigation={(
        <DashboardNavigation
          filtersOpen={filtersOpen}
          hasActiveFilters={hasActiveFilters}
          onFiltersToggle={handleFiltersToggle}
          filtersTriggerRef={filtersTriggerRef}
          activityOpen={activityOpen}
          hasSelectedDates={selectedDates.size > 0}
          onActivityToggle={handleActivityToggle}
          billingEntryLoading={dashboardBillingEntryLoading}
          billingLabel={dashboardBillingEntryPoint.label}
          billingOpensDialog={billingOpensDialog}
          billingDialogOpen={upgradeModalOpen}
          onBillingEntry={handleDashboardBillingEntry}
        />
      )}
      filters={(
        <JobStatsSidebar
          mode={isWideLayout ? 'docked' : 'drawer'}
          isOpen={filtersOpen}
          onClose={handleFiltersClose}
          statusCounts={statusCounts}
          total={totalJobs}
          loading={loading}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          hasSearchFilter={Boolean(searchQuery)}
          jobs={allJobs}
          salaryFilterMin={salaryFilterMin}
          salaryFilterMax={salaryFilterMax}
          onSalaryFilterMinChange={setSalaryFilterMin}
          onSalaryFilterMaxChange={setSalaryFilterMax}
          onClearAllFilters={handleClearAllFilters}
          archivedCount={archivedCount}
        />
      )}
    >
      <main className="min-w-0 px-3 py-4 sm:px-4 lg:px-5 wide:px-6">
        <div className="mb-3 flex min-w-0 justify-end">
          <ProfileDropdown user={user} onSignOut={handleSignOut} />
        </div>

        <DashboardToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchResetKey={searchResetKey}
          searchDisabled={loading}
          addExpanded={showForm}
          addDisabled={saving}
          addTriggerRef={addApplicationTriggerRef}
          onAddToggle={toggleAddForm}
        />

        {error && (
          <div
            role="alert"
            className="mb-5 mt-4 flex flex-col gap-3 rounded-dashboard-panel border border-red-400/55 bg-red-500/10 px-4 py-3 text-red-100 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="text-sm leading-6">{error.message}</span>
            <button
              type="button"
              onClick={clearError}
              className="dashboard-focus-ring inline-flex min-h-9 shrink-0 items-center justify-center self-start rounded-dashboard-control border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-100 transition-colors hover:bg-red-500/20 sm:self-auto"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-4">
          <StorageDowngradeBanner storageSummary={storageSummary} />
        </div>
        <LockedArchivePanel storageSummary={storageSummary} onArchiveDeleted={refreshStorageSummary} />

        <div className="mt-4">
          {showForm && (
            <JobForm
              onSubmit={handleAddJob}
              onCancel={handleAddFormClose}
              saving={saving}
            />
          )}

          {loading ? (
            <div
              role="status"
              aria-live="polite"
              className="dashboard-major-panel flex min-h-40 items-center justify-center gap-3 rounded-dashboard-panel bg-dashboard-surface/90 px-5 py-12 text-sm text-dashboard-muted"
            >
              <Spinner size="md" className="text-dashboard-accent-hover" />
              <span>Loading applications...</span>
            </div>
          ) : jobs.length === 0 ? (
            <div className="dashboard-major-panel rounded-dashboard-panel bg-dashboard-surface/90 px-5 py-14 text-center text-dashboard-muted">
              {hasResultFilters ? (
                <div>
                  <h2 className="text-base font-semibold text-dashboard-text">No matching applications</h2>
                  <ul className="mt-2 space-y-1 text-sm">
                    {searchQuery && (
                      <li>No jobs matching &ldquo;{searchQuery}&rdquo;.</li>
                    )}
                    {statusFilter && (
                      <li>No jobs with status &ldquo;{statusFilterLabel}&rdquo;.</li>
                    )}
                    {selectedDates.size > 0 && (
                      <li>No jobs found for the selected dates.</li>
                    )}
                    {(salaryFilterMin != null || salaryFilterMax != null) && (
                      <li>No jobs in the selected salary range.</li>
                    )}
                  </ul>
                </div>
              ) : (
                <div>
                  <h2 className="text-base font-semibold text-dashboard-text">No job applications yet.</h2>
                  <p className="mt-2 text-sm">Choose Add Application to get started.</p>
                </div>
              )}
            </div>
          ) : (
            <JobTable
              jobs={jobs}
              onEdit={openEditForm}
              onDelete={handleDeleteJob}
              deleting={deleting}
            />
          )}
          {!loading && (
            <NextPageButton
              currentPage={currentPage}
              totalCount={totalCount}
              pageSize={pageSize}
              onPageChange={goToPage}
            />
          )}
        </div>

        {/* Activity calendar — desktop: inline bottom-left, mobile: drawer */}
        <div
          id="dashboard-activity-drawer"
          aria-hidden={activityOpen ? undefined : 'true'}
          inert={activityOpen ? undefined : ''}
        >
          <ActivityDrawer
            isOpen={activityOpen}
            onClose={() => setActivityOpen(false)}
            jobs={allJobs}
            selectedDates={selectedDates}
            onDateToggle={handleDateToggle}
            onClearDates={clearSelectedDates}
          />
        </div>
        <UpgradePlanModal
          isOpen={upgradeModalOpen}
          plan={PREMIUM_MONTHLY_PLAN}
          onClose={handleUpgradeModalClose}
          onUnauthorized={handleBillingUnauthorized}
          onGoToBilling={handleBillingNavigation}
        />
        {editingJob && (
          <EditModal
            job={editingJob}
            onSave={handleUpdateJob}
            onClose={closeEditForm}
            saving={saving}
          />
        )}

        <DeleteModal
          job={jobToDelete}
          onConfirm={confirmDeleteJob}
          onClose={() => setJobToDelete(null)}
          deleting={deleting === jobToDelete?.id}
        />
      </main>
      <footer className="py-4 text-center text-dashboard-caption text-dashboard-muted">
        <a target="_blank" rel="noopener noreferrer" href="https://icons8.com/icon/hH1yYj2eECWj/job" className="hover:text-dashboard-text">Icon</a> by <a target="_blank" rel="noopener noreferrer" href="https://icons8.com" className="hover:text-dashboard-text">Icons8</a>
      </footer>
    </DashboardShell>
  );
}
