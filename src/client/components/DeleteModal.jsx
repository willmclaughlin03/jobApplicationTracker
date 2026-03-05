import Spinner from './Spinner.jsx';

/**
 * DeleteModal - Confirmation dialog before deleting a job application.
 * Mirrors the EditModal overlay/card pattern.
 * @param {Object} job - The job to delete; renders nothing if null
 * @param {Function} onConfirm - Called with no args to proceed with deletion
 * @param {Function} onClose - Called to dismiss without deleting
 * @param {boolean} deleting - Whether a delete request is in flight
 */
export default function DeleteModal({ job, onConfirm, onClose, deleting }) {
  if (!job) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-5"
      onClick={handleOverlayClick}
    >
      <div className="bg-white p-6 rounded-lg w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Delete Application</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-5 break-words">
          Are you sure you want to delete <strong>{job.company}</strong>
          {' \u2014 '}{job.position}? This cannot be undone.
        </p>

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="bg-gray-100 text-gray-700 border border-gray-300 px-5 py-2 rounded text-sm font-medium hover:bg-gray-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="bg-red-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {deleting ? <><Spinner size="sm" className="inline mr-1.5" />Deleting...</> : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
