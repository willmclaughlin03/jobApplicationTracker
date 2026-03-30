import { useState } from 'react';
import Spinner from '../Spinner.jsx';

/**
 * AdminRoleControl - Inline role management for the user detail page.
 *
 * Purpose: Shows the user's current role and lets admins promote/demote.
 * An inline confirmation step appears before submitting — no modal needed.
 * Self-action is disabled both here (UX guard) and server-side (authoritative guard).
 *
 * Connects to: useAdminUser.updateRole, /pages/admin/users/[id].js (parent)
 *
 * @param {Object} props
 * @param {'admin'|'user'} props.currentRole - The user's current role
 * @param {string} props.targetId - The target user's ID
 * @param {string} props.currentUserId - The logged-in admin's ID (for self-action guard)
 * @param {boolean} props.updating - Whether an update request is in flight
 * @param {Function} props.onUpdate - Called with new role string to submit the change
 */
export default function AdminRoleControl({ currentRole, targetId, currentUserId, updating, onUpdate }) {
  const [confirming, setConfirming] = useState(false);

  const isSelf = targetId === currentUserId;
  const targetRole = currentRole === 'admin' ? 'user' : 'admin';
  const actionLabel = currentRole === 'admin' ? 'Demote to user' : 'Promote to admin';

  const handleClick = () => {
    if (isSelf || updating) return;
    setConfirming(true);
  };

  const handleConfirm = async () => {
    setConfirming(false);
    await onUpdate(targetRole);
  };

  const handleCancel = () => setConfirming(false);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Role</h3>

      <div className="flex items-center gap-3 flex-wrap">
        {currentRole === 'admin' ? (
          <span className="inline-flex items-center px-2.5 py-1 rounded text-sm font-medium bg-orange-100 text-orange-800">
            admin
          </span>
        ) : (
          <span className="inline-flex items-center px-2.5 py-1 rounded text-sm font-medium bg-gray-100 text-gray-600">
            user
          </span>
        )}

        {!confirming && (
          <button
            onClick={handleClick}
            disabled={isSelf || updating}
            title={isSelf ? 'You cannot change your own role' : undefined}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {updating ? <><Spinner size="sm" className="inline mr-1" />Updating...</> : actionLabel}
          </button>
        )}
      </div>

      {isSelf && (
        <p className="mt-2 text-xs text-gray-400">You cannot change your own role.</p>
      )}

      {confirming && (
        <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
          <p className="text-yellow-800 mb-3">
            {currentRole === 'admin'
              ? 'Demote this user to a regular user? They will lose admin access immediately.'
              : 'Promote this user to admin? They will gain full admin access immediately.'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={handleCancel}
              className="bg-gray-100 text-gray-700 border border-gray-300 px-4 py-1.5 rounded text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
