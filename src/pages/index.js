import { useState } from 'react';
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
import InfoTooltip from '../client/components/InfoTooltip';
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

export default function Dashboard() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [salaryFilterMin, setSalaryFilterMin] = useState(null);
  const [salaryFilterMax, setSalaryFilterMax] = useState(null);
  const [selectedDates, setSelectedDates] = useState(new Set());

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
  const dashboardBillingEntryPoint = getDashboardBillingEntryPoint(storageSummary?.status);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [jobToDelete, setJobToDelete] = useState(null);

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
    return <DashboardSkeleton />;
  }

  const handleAddJob = async (jobData) => {
    const result = await addJob(jobData);
    if (result.success) closeAddForm();
  };

  const handleUpdateJob = async (id, updates) => {
    const result = await updateJob(id, updates);
    if (result.success) closeEditForm();
  };

  const handleDeleteJob = (id) => {
    const job = jobs.find(j => j.id === id);
    if (job) setJobToDelete(job);
  };

  const confirmDeleteJob = async () => {
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
      const hasActiveOverlay = sidebarOpen
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

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-800">Track The App</h1>
          <ProfileDropdown user={user} onSignOut={handleSignOut} />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-100 text-red-800 px-4 py-3 rounded mb-5 flex justify-between items-center">
            <span>{error.message}</span>
            <button onClick={clearError} className="text-red-800 hover:text-red-900 text-sm">
              Dismiss
            </button>
          </div>
        )}

        <JobStatsSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          statusCounts={statusCounts}
          total={totalJobs}
          loading={loading}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          jobs={allJobs}
          salaryFilterMin={salaryFilterMin}
          salaryFilterMax={salaryFilterMax}
          onSalaryFilterMinChange={setSalaryFilterMin}
          onSalaryFilterMaxChange={setSalaryFilterMax}
          archivedCount={archivedCount}
        />

        <StorageDowngradeBanner storageSummary={storageSummary} />
        <LockedArchivePanel storageSummary={storageSummary} onArchiveDeleted={refreshStorageSummary} />

        <div>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                className="relative flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-4 py-2.5 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M7 8h10M10 12h4" />
                </svg>
                Filters
                {(statusFilter || searchQuery || salaryFilterMin != null || salaryFilterMax != null) && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-blue-500" />
                )}
              </button>
              <button
                onClick={() => setActivityOpen(true)}
                className="relative flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-4 py-2.5 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Activity
                {selectedDates.size > 0 && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-blue-500" />
                )}
              </button>
              <button
                type="button"
                onClick={handleDashboardBillingEntry}
                aria-haspopup={
                  dashboardBillingEntryPoint.action
                    === DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL
                    ? 'dialog'
                    : undefined
                }
                aria-expanded={
                  dashboardBillingEntryPoint.action
                    === DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL
                    ? upgradeModalOpen
                    : undefined
                }
                className="relative flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-4 py-2.5 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 8.25h19.5M3.75 18h16.5a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0020.25 6H3.75a1.5 1.5 0 00-1.5 1.5v9A1.5 1.5 0 003.75 18z" />
                </svg>
                {dashboardBillingEntryPoint.label}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <InfoTooltip />
              <button
                onClick={toggleAddForm}
                className="bg-blue-600 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                disabled={saving}
              >
                {showForm ? 'Cancel' : 'Add New Job'}
              </button>
            </div>
          </div>

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
                <p>No job applications yet. Click &ldquo;Add New Job&rdquo; to get started!</p>
              )}
            </div>
          ) : (
            <>
              <JobTable
                jobs={jobs}
                onEdit={openEditForm}
                onDelete={handleDeleteJob}
                deleting={deleting}
              />
              <NextPageButton
                currentPage={currentPage}
                totalCount={totalCount}
                pageSize={pageSize}
                onPageChange={goToPage}
              />
            </>
          )}
        </div>

        {/* Activity calendar — desktop: inline bottom-left, mobile: drawer */}
        <ActivityDrawer
          isOpen={activityOpen}
          onClose={() => setActivityOpen(false)}
          jobs={allJobs}
          selectedDates={selectedDates}
          onDateToggle={handleDateToggle}
          onClearDates={clearSelectedDates}
        />
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
      <footer className="text-center text-xs text-gray-400 py-4">
        <a target="_blank" rel="noopener noreferrer" href="https://icons8.com/icon/hH1yYj2eECWj/job" className="hover:text-gray-500">Icon</a> by <a target="_blank" rel="noopener noreferrer" href="https://icons8.com" className="hover:text-gray-500">Icons8</a>
      </footer>
    </div>
  );
}
