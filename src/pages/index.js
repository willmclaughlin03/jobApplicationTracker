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
import InfoTooltip from '../client/components/InfoTooltip';
import ActivityDrawer from '../client/components/ActivityDrawer';

export default function Dashboard() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [salaryFilterMin, setSalaryFilterMin] = useState(null);
  const [salaryFilterMax, setSalaryFilterMax] = useState(null);

  const {
    jobs,
    allJobs,
    loading,
    saving,
    deleting,
    error,
    clearError,
    addJob,
    updateJob,
    deleteJob,
    currentPage,
    totalCount,
    totalJobs,
    statusCounts,
    pageSize,
    goToPage,
  } = useJobs(user?.id, statusFilter, searchQuery, salaryFilterMin, salaryFilterMax);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
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
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" className="text-gray-400" />
      </div>
    );
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

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-800">Job Application Tracker</h1>
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
        />

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
                className="flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-4 py-2.5 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Activity
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
              <p>
                {searchQuery
                  ? `No jobs matching "${searchQuery}"${statusFilter ? ` with status "${statusFilter}"` : ''}.`
                  : statusFilter
                  ? `No jobs with status "${statusFilter}".`
                  : 'No job applications yet. Click "Add New Job" to get started!'}
              </p>
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
