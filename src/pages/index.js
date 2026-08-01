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

export default function Dashboard() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const isWideLayout = useDashboardWideLayout();
  const filtersTriggerRef = useRef(null);
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

  if (!authLoading && !user) {
    router.push('/login');
    return null;
  }

  if (authLoading) {
    return (
      <DashboardShell>
        <DashboardSkeleton />
      </DashboardShell>
    );
  }

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

  const handleAddJob = async (jobData) => {
    const result = await addJob(jobData);
    if (result.success) closeAddForm();
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
   * @returns {Promise<void>} Resolves after the mutation settles or is skipped.
   */
  const confirmDeleteJob = async () => {
    if (!jobToDelete || deleting) {
      return;
    }

    const result = await deleteJob(jobToDelete.id);
    if (result.success) setJobToDelete(null);
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
        <DashboardToolbar
          user={user}
          onSignOut={handleSignOut}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchResetKey={searchResetKey}
          searchDisabled={loading}
          addExpanded={showForm}
          addDisabled={saving}
          onAddToggle={toggleAddForm}
        />

        {error && (
          <div className="mt-4 bg-red-100 text-red-800 px-4 py-3 rounded mb-5 flex justify-between items-center">
            <span>{error.message}</span>
            <button type="button" onClick={clearError} className="text-red-800 hover:text-red-900 text-sm">
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
              onCancel={closeAddForm}
              saving={saving}
            />
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="md" className="text-gray-400" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-16 px-5 text-gray-500 bg-white rounded-lg">
              {searchQuery || statusFilter || selectedDates.size > 0 ? (
                <ul className="space-y-1">
                  {searchQuery && (
                    <li>No jobs matching &ldquo;{searchQuery}&rdquo;.</li>
                  )}
                  {statusFilter && (
                    <li>No jobs with status &ldquo;{statusFilter}&rdquo;.</li>
                  )}
                  {selectedDates.size > 0 && (
                    <li>No jobs found for the selected dates.</li>
                  )}
                </ul>
              ) : (
                <p>No job applications yet. Click &ldquo;Add Application&rdquo; to get started!</p>
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
