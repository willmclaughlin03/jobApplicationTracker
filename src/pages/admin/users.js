import { useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../client/contexts/AuthContext';
import { useAdminUsers } from '../../client/hooks/useAdminUsers';
import AdminUserTable from '../../client/components/admin/AdminUserTable';
import AdminDeleteUserModal from '../../client/components/admin/AdminDeleteUserModal';
import ProfileDropdown from '../../client/components/ProfileDropdown';
import Spinner from '../../client/components/Spinner';
import { getUserFromRequest } from '../../server/lib/supabaseServer.js';
import { requireAdmin } from '../../server/lib/requireAdmin.js';

/**
 * Adapt a page response to the chainable interface used by requireAdmin.
 *
 * Purpose: getServerSideProps receives a Node ServerResponse rather than a
 * NextApiResponse, so this adapter forwards the existing 403 response without
 * weakening or duplicating the shared admin-role decision.
 *
 * @param {import('http').ServerResponse} res - Direct page response.
 * @returns {object} Minimal status/json response used by requireAdmin.
 */
function createPageAdminResponse(res) {
  const response = {
    /** Forward the authorization status code to the page response. */
    status(statusCode) {
      res.statusCode = statusCode;
      return response;
    },
    /** Serialize and finish the authorization response before page rendering. */
    json(payload) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return response;
    },
  };

  return response;
}

/**
 * Authenticate and authorize direct requests before rendering the Admin shell.
 *
 * Purpose: client redirects remain a UX fallback, while server-side validation
 * prevents authenticated non-admins from receiving protected page markup.
 * Authentication may refresh session cookies; requireAdmin finishes denied
 * responses with the existing standardized 403 body.
 *
 * @param {import('next').GetServerSidePropsContext} context - Page request context.
 * @returns {Promise<object>} Redirect, denied-response sentinel, or page props.
 */
export async function getServerSideProps({ req, res }) {
  const { user } = await getUserFromRequest(req, res);

  if (!user) {
    return {
      redirect: { destination: '/login', permanent: false },
    };
  }

  if (!requireAdmin(user, createPageAdminResponse(res))) {
    return { props: {} };
  }

  return { props: {} };
}

export default function AdminUsersPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  const { users, loading, error, page, setPage, hasMore, deleting, deleteUser, clearError } = useAdminUsers({ enabled: !authLoading && user?.role === 'admin' });
  const [userToDelete, setUserToDelete] = useState(null);

  // Auth guard — redirect unauthenticated users
  if (!authLoading && !user) {
    router.replace('/login');
    return null;
  }

  // Role guard — redirect authenticated non-admins
  if (!authLoading && user && user.role !== 'admin') {
    router.replace('/');
    return null;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" className="text-gray-400" />
      </div>
    );
  }

  const handleDeleteRequest = (id) => {
    const target = users.find(u => u.id === id);
    if (target) setUserToDelete(target);
  };

  const handleDeleteConfirm = async () => {
    const result = await deleteUser(userToDelete.id);
    if (result.success) setUserToDelete(null);
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← Dashboard
            </button>
            <h1 className="text-xl font-semibold text-gray-800">Admin — Users</h1>
          </div>
          <ProfileDropdown user={user} onSignOut={handleSignOut} />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-100 text-red-800 px-4 py-3 rounded mb-5 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={clearError} className="text-red-800 hover:text-red-900 text-sm">
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" className="text-gray-400" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 text-gray-500 bg-white rounded-lg border border-gray-200">
            No users found.
          </div>
        ) : (
          <>
            <AdminUserTable
              users={users}
              onDelete={handleDeleteRequest}
              deleting={deleting}
            />

            <div className="flex items-center justify-between mt-4">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
                className="text-sm text-gray-600 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Previous
              </button>
              <span className="text-sm text-gray-500">Page {page}</span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={!hasMore || loading}
                className="text-sm text-gray-600 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </main>

      <AdminDeleteUserModal
        user={userToDelete}
        onConfirm={handleDeleteConfirm}
        onClose={() => setUserToDelete(null)}
        deleting={deleting === userToDelete?.id}
      />
    </div>
  );
}
