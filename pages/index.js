import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import { useJobs } from '../hooks/useJobs';
import { useJobStats } from '../hooks/useJobStats';
import { useJobFormModal } from '../hooks/useJobFormModal';
import JobTable from '../components/JobTable';
import JobForm from '../components/JobForm';
import EditModal from '../components/EditModal';
import NextPageButton from '../components/NextPageButton';
import JobStatsSidebar from '../components/JobStatsSidebar';

export default function Dashboard() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState(null);

  const {
    statusCounts,
    total: totalJobs,
    loading: statsLoading,
    refetch: refetchStats,
  } = useJobStats(user?.id);

  const {
    jobs,
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
    pageSize,
    goToPage,
  } = useJobs(user?.id, statusFilter);

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
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Loading...
      </div>
    );
  }

  const handleAddJob = async (jobData) => {
    const result = await addJob(jobData);
    if (result.success) {
      closeAddForm();
      refetchStats();
    }
  };

  const handleUpdateJob = async (id, updates) => {
    const result = await updateJob(id, updates);
    if (result.success) {
      closeEditForm();
      refetchStats();
    }
  };

  const handleDeleteJob = async (id) => {
    if (window.confirm('Are you sure you want to delete this job application?')) {
      const result = await deleteJob(id);
      if (result.success) {
        refetchStats();
      }
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-5xl mx-auto flex flex-col items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-800">Job Application Tracker</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{user?.email}</span>
            <button
              onClick={handleSignOut}
              className="bg-gray-100 text-gray-700 border border-gray-300 px-4 py-2 rounded text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              Sign Out
            </button>
          </div>
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

        <div className="flex flex-col md:flex-row gap-6">
          <div className="md:w-64 flex-shrink-0">
            <JobStatsSidebar
              statusCounts={statusCounts}
              total={totalJobs}
              loading={statsLoading}
              activeFilter={statusFilter}
              onFilterChange={setStatusFilter}
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex justify-center mb-6">
              <button
                onClick={toggleAddForm}
                className="bg-blue-600 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                disabled={saving}
              >
                {showForm ? 'Cancel' : 'Add New Job'}
              </button>
            </div>

            {showForm && (
              <JobForm
                onSubmit={handleAddJob}
                onCancel={closeAddForm}
                saving={saving}
              />
            )}

            {loading ? (
              <div className="flex items-center justify-center py-12 text-gray-500">
                Loading jobs...
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-16 px-5 text-gray-500 bg-white rounded-lg">
                <p>{statusFilter ? `No jobs with status "${statusFilter}".` : 'No job applications yet. Click "Add New Job" to get started!'}</p>
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
        </div>

        {editingJob && (
          <EditModal
            job={editingJob}
            onSave={handleUpdateJob}
            onClose={closeEditForm}
            saving={saving}
          />
        )}
      </main>
    </div>
  );
}
