import { applyProtectedPageCache } from '../../../server/lib/protectedPageCache.js';

/**
 * Opt this protected shell into request-time rendering and prevent CDN storage.
 * Middleware and existing client/API guards retain their authentication duties;
 * no user data or credentials are serialized into props by this cache boundary.
 * @param {import('next').GetServerSidePropsContext} context - Page response.
 * @returns {Promise<{props: object}>} Empty props for the existing client shell.
 */
export async function getServerSideProps({ res }) {
  applyProtectedPageCache(res);
  return { props: {} };
}

import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../client/contexts/AuthContext';
import { useAdminUser } from '../../../client/hooks/useAdminUser';
import AdminRoleControl from '../../../client/components/admin/AdminRoleControl';
import AdminActivitySummary from '../../../client/components/admin/AdminActivitySummary';
import AdminDeleteUserModal from '../../../client/components/admin/AdminDeleteUserModal';
import ProfileDropdown from '../../../client/components/ProfileDropdown';
import Spinner from '../../../client/components/Spinner';

export default function AdminUserDetailPage() {
  const { user: currentUser, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const { id } = router.query;

  const { user, activity, loading, error, updating, deleting, updateRole, deleteUser, clearError } = useAdminUser(id, { enabled: !authLoading && currentUser?.role === 'admin' });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [roleError, setRoleError] = useState(null);

  // Auth guard
  if (!authLoading && !currentUser) {
    router.replace('/login');
    return null;
  }

  // Role guard
  if (!authLoading && currentUser && currentUser.role !== 'admin') {
    router.replace('/');
    return null;
  }

  if (authLoading || !id) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" className="text-gray-400" />
      </div>
    );
  }

  const handleRoleUpdate = async (newRole) => {
    setRoleError(null);
    const result = await updateRole(newRole);
    if (!result.success) setRoleError(result.message);
  };

  const handleDeleteConfirm = async () => {
    const result = await deleteUser();
    if (result.success) {
      router.replace('/admin/users');
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  const formattedDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/admin/users')}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← Users
            </button>
            <h1 className="text-xl font-semibold text-gray-800">User Detail</h1>
          </div>
          <ProfileDropdown user={currentUser} onSignOut={handleSignOut} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        {(error || roleError) && (
          <div className="bg-red-100 text-red-800 px-4 py-3 rounded flex justify-between items-center">
            <span>{error ?? roleError}</span>
            <button
              onClick={() => { clearError(); setRoleError(null); }}
              className="text-red-800 hover:text-red-900 text-sm"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" className="text-gray-400" />
          </div>
        ) : !user ? null : (
          <>
            {/* Account info */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Account</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-28 shrink-0">Email</dt>
                  <dd className="text-gray-800 break-all">{user.email}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-28 shrink-0">User ID</dt>
                  <dd className="text-gray-500 font-mono text-xs break-all">{user.id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-28 shrink-0">Joined</dt>
                  <dd className="text-gray-800">{formattedDate(user.created_at)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-28 shrink-0">Last active</dt>
                  <dd className="text-gray-800">{formattedDate(user.last_sign_in_at)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-28 shrink-0">Email verified</dt>
                  <dd className="text-gray-800">{user.email_confirmed_at ? formattedDate(user.email_confirmed_at) : 'No'}</dd>
                </div>
              </dl>
            </div>

            {/* Role management */}
            <AdminRoleControl
              currentRole={user.role}
              targetId={user.id}
              currentUserId={currentUser.id}
              updating={updating}
              onUpdate={handleRoleUpdate}
            />

            {/* Activity summary */}
            <AdminActivitySummary activity={activity} />

            {/* Danger zone */}
            <div className="bg-white rounded-lg border border-red-200 p-4">
              <h3 className="text-sm font-semibold text-red-700 mb-3">Danger Zone</h3>
              <p className="text-sm text-gray-600 mb-3">
                Permanently delete this account and all associated job applications.
              </p>
              <button
                onClick={() => setShowDeleteModal(true)}
                disabled={deleting}
                className="bg-red-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                Delete User Account
              </button>
            </div>
          </>
        )}
      </main>

      <AdminDeleteUserModal
        user={showDeleteModal ? user : null}
        onConfirm={handleDeleteConfirm}
        onClose={() => setShowDeleteModal(false)}
        deleting={deleting}
      />
    </div>
  );
}
