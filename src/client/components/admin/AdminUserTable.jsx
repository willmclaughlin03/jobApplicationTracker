import { useRouter } from 'next/router';
import AdminUserTableRow from './AdminUserTableRow.jsx';
import Spinner from '../Spinner.jsx';

/**
 * AdminUserTable - Responsive table of all registered users.
 *
 * Purpose: Renders the admin user list with email, role badge, dates, and actions.
 * Desktop: standard table layout. Mobile: stacked card layout.
 * Connects to: AdminUserTableRow, /pages/admin/users.js (parent)
 *
 * @param {Object} props
 * @param {Array} props.users - Array of { id, email, role, created_at, last_sign_in_at }
 * @param {Function} props.onDelete - Called with user.id to open delete confirmation
 * @param {string|null} props.deleting - ID of user currently being deleted, or null
 */
export default function AdminUserTable({ users, onDelete, deleting }) {
  const router = useRouter();

  const formattedDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Joined</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Active</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <AdminUserTableRow
                key={user.id}
                user={user}
                onDelete={onDelete}
                deleting={deleting}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden space-y-3">
        {users.map(user => (
          <div key={user.id} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-2 mb-3">
              <p className="text-sm font-medium text-gray-800 break-all">{user.email}</p>
              {user.role === 'admin' ? (
                <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                  admin
                </span>
              ) : (
                <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                  user
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 space-y-1 mb-3">
              <p>Joined: {formattedDate(user.created_at)}</p>
              <p>Last active: {formattedDate(user.last_sign_in_at)}</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => router.push(`/admin/users/${user.id}`)}
                disabled={!!deleting}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                View
              </button>
              <button
                onClick={() => onDelete(user.id)}
                disabled={!!deleting}
                className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting === user.id ? <><Spinner size="sm" className="inline" /> Deleting...</> : 'Delete'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
