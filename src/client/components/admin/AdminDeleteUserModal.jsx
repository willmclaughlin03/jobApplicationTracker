import { useState } from 'react';
import Spinner from '../Spinner.jsx';

/**
 * AdminDeleteUserModal - Destructive-action confirmation modal for user deletion.
 *
 * Purpose: Requires the admin to type the target user's email before deletion
 * is allowed, matching the GitHub repo-deletion confirmation pattern.
 * Connects to: /pages/admin/users.js, /pages/admin/users/[id].js
 *
 * @param {Object} props
 * @param {Object|null} props.user - User to delete { id, email }; renders nothing if null
 * @param {Function} props.onConfirm - Called with no args to proceed with deletion
 * @param {Function} props.onClose - Called to dismiss without deleting
 * @param {boolean} props.deleting - Whether a delete request is in flight
 */
export default function AdminDeleteUserModal({ user, onConfirm, onClose, deleting }) {
  const [confirmation, setConfirmation] = useState('');

  if (!user) return null;

  // Normalize both sides — emails are case-insensitive and Supabase stores them
  // lowercase, so an admin typing mixed case should still be able to confirm.
  const confirmed = confirmation.trim().toLowerCase() === user.email.toLowerCase();

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget && !deleting) onClose();
  };

  const handleClose = () => {
    if (!deleting) {
      setConfirmation('');
      onClose();
    }
  };

  const handleConfirm = () => {
    if (!confirmed || deleting) return;
    onConfirm();
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-5"
      onClick={handleOverlayClick}
    >
      <div className="bg-white p-6 rounded-lg w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Delete User Account</h2>
          <button
            onClick={handleClose}
            disabled={deleting}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none disabled:cursor-not-allowed"
          >
            &times;
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-1 break-words">
          This will permanently delete <strong className="break-all">{user.email}</strong> and all their job applications. This cannot be undone.
        </p>

        <p className="text-sm text-gray-600 mb-3">
          Type the user&apos;s email to confirm:
        </p>

        <input
          type="email"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={user.email}
          disabled={deleting}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-5 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:bg-gray-50 disabled:cursor-not-allowed"
          autoComplete="off"
        />

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={handleClose}
            disabled={deleting}
            className="bg-gray-100 text-gray-700 border border-gray-300 px-5 py-2 rounded text-sm font-medium hover:bg-gray-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!confirmed || deleting}
            className="bg-red-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {deleting ? <><Spinner size="sm" className="inline mr-1.5" />Deleting...</> : 'Delete User'}
          </button>
        </div>
      </div>
    </div>
  );
}
