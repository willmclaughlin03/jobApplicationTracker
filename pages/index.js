import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import { useJobs } from '../hooks/useJobs';
import JobTable from '../components/JobTable';
import JobForm from '../components/JobForm';
import EditModal from '../components/EditModal';

export default function Dashboard() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const { jobs, loading, saving, deleting, error, clearError, addJob, updateJob, deleteJob } = useJobs(user?.id);

  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState(null);

  // Redirect if not authenticated
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
      setShowForm(false);
    }
  };

  const handleEditJob = (job) => {
    setEditingJob(job);
  };

  const handleUpdateJob = async (id, updates) => {
    const result = await updateJob(id, updates);
    if (result.success) {
      setEditingJob(null);
    }
  };

  const handleDeleteJob = async (id) => {
    if (window.confirm('Are you sure you want to delete this job application?')) {
      await deleteJob(id);
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

      <main className="max-w-5xl mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-100 text-red-800 px-4 py-3 rounded mb-5 flex justify-between items-center">
            <span>{error.message}</span>
            <button onClick={clearError} className="text-red-800 hover:text-red-900 text-sm">
              Dismiss
            </button>
          </div>
        )}

        <div className="flex justify-center mb-6">
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            disabled={saving}
          >
            {showForm ? 'Cancel' : 'Add New Job'}
          </button>
        </div>

        {showForm && (
          <JobForm
            onSubmit={handleAddJob}
            onCancel={() => setShowForm(false)}
            saving={saving}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            Loading jobs...
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-16 px-5 text-gray-500 bg-white rounded-lg">
            <p>No job applications yet. Click "Add New Job" to get started!</p>
          </div>
        ) : (
          <JobTable
            jobs={jobs}
            onEdit={handleEditJob}
            onDelete={handleDeleteJob}
            deleting={deleting}
          />
        )}

        {editingJob && (
          <EditModal
            job={editingJob}
            onSave={handleUpdateJob}
            onClose={() => setEditingJob(null)}
            saving={saving}
          />
        )}
      </main>
    </div>
  );
}