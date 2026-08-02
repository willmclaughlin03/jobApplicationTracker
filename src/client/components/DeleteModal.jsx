import { TriangleAlert, X } from 'lucide-react';
import Spinner from './Spinner.jsx';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility.js';

const DELETE_DIALOG_TITLE_ID = 'delete-application-dialog-title';
const DELETE_DIALOG_DESCRIPTION_ID = 'delete-application-dialog-description';

/**
 * DeleteModal - Confirmation dialog before deleting a job application.
 * Mirrors the EditModal overlay/card pattern.
 * @param {Object} job - The job to delete; renders nothing if null
 * @param {Function} onConfirm - Called with no args to proceed with deletion
 * @param {Function} onClose - Called to dismiss without deleting
 * @param {boolean} deleting - Whether a delete request is in flight
 */
export default function DeleteModal({ job, onConfirm, onClose, deleting }) {
  const { containerRef } = useOverlayAccessibility(Boolean(job), onClose);

  if (!job) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[#010907]/85 p-4 sm:p-5"
      onClick={handleOverlayClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={DELETE_DIALOG_TITLE_ID}
        aria-describedby={DELETE_DIALOG_DESCRIPTION_ID}
        aria-busy={deleting || undefined}
        tabIndex={-1}
        className="dashboard-raised-panel w-full max-w-md p-4 text-dashboard-text sm:p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-400/40 bg-red-500/10 text-red-300">
              <TriangleAlert aria-hidden="true" size={20} />
            </span>
            <h2 id={DELETE_DIALOG_TITLE_ID} className="text-lg font-semibold text-dashboard-text">
              Delete Application
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close delete application dialog"
            className="dashboard-focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-dashboard-control text-dashboard-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        <p
          id={DELETE_DIALOG_DESCRIPTION_ID}
          className="mb-5 break-words border-y border-dashboard-line py-4 text-sm text-dashboard-muted"
        >
          Are you sure you want to delete <strong>{job.company}</strong>
          {' — '}{job.position}? <span className="font-medium text-red-300">This cannot be undone.</span>
        </p>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="dashboard-control dashboard-focus-ring min-h-9 px-5 py-2 text-sm font-medium text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm()}
            disabled={deleting}
            className="dashboard-focus-ring min-h-9 rounded-dashboard-control border border-red-400/70 bg-red-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? <><Spinner size="sm" className="mr-1.5 inline" />Deleting...</> : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
