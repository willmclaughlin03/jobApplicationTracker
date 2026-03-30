import { useRouter } from 'next/router';
import Spinner from '../Spinner.jsx';

/**
 * AdminUserTableRow - Single row in the admin user table.
 *
 * Purpose: Renders one user's data with View and Delete action buttons.
 * Connects to: AdminUserTable (parent), useAdminUsers (via page)
 *
 * @param {Object} props
 * @param {Object} props.user - { id, email, role, created_at, last_sign_in_at }
 * @param {Function} props.onDelete - Called with user.id to open delete confirmation
 * @param {string|null} props.deleting - ID of the user currently being deleted, or null
 */
export default function AdminUserTableRow({ user, onDelete, deleting }) {
  const router = useRouter();
  const isDeleting = deleting === user.id;

  const formattedDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-sm text-gray-800 max-w-xs truncate">{user.email}</td>
      <td className="px-4 py-3">
        {user.role === 'admin' ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
            admin
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
            user
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">{formattedDate(user.created_at)}</td>
      <td className="px-4 py-3 text-sm text-gray-500">{formattedDate(user.last_sign_in_at)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/admin/users/${user.id}`)}
            disabled={isDeleting}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            View
          </button>
          <button
            onClick={() => onDelete(user.id)}
            disabled={!!deleting}
            className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {isDeleting ? <><Spinner size="sm" className="inline" /> Deleting...</> : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
  );
}
