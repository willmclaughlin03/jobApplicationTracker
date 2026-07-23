import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatStorageDate, getStorageCount, hasLockedArchive } from '../lib/storageSummaryUi.js';
import { normalizeError, ERROR_MESSAGES } from '../../shared/errors.js';
import { STORAGE_STATUSES } from '../../shared/constants/billing.js';

const LOCKED_ARCHIVE_PREVIEW_PATH = '/api?storage_state=locked&from=0&to=14';
const LOCKED_ARCHIVE_DELETE_PATH = '/api/storage/locked-jobs';
const LOCKED_ARCHIVE_DELETE_CONFIRMATION = 'permanently_delete_locked_jobs';

/**
 * Formats a locked teaser timestamp for compact archive rows.
 *
 * Purpose: locked archive teasers expose timestamps but no job details, so the
 * panel needs safe date text for created/locked metadata.
 *
 * @param {string|number|Date|null|undefined} value - Raw timestamp value.
 * @returns {string} User-facing date text.
 */
function formatArchiveTeaserDate(value) {
  return formatStorageDate(value) ?? 'Date unavailable';
}

/**
 * Maps the v1 lock reason to customer-facing teaser copy.
 *
 * Purpose: avoid showing internal enum text while still explaining why the row
 * appears in the archive.
 *
 * @param {string|null|undefined} reason - Locked reason from the teaser row.
 * @returns {string} Short reason label.
 */
function formatLockedReason(reason) {
  return reason === 'premium_to_free_over_plan_limit'
    ? 'Moved after Premium ended'
    : 'Archived by storage policy';
}

/**
 * Checks whether the current summary may show locked bulk-delete controls.
 *
 * Purpose: Chunk 10 deletion is only for confirmed terminal-Free users with an
 * existing locked archive, never Premium, ambiguous, dunning, or sync states.
 *
 * @param {object|null|undefined} storageSummary - Count-only storage metadata.
 * @returns {boolean} True when the delete affordance can render.
 */
function canShowLockedArchiveDelete(storageSummary) {
  return storageSummary?.status === STORAGE_STATUSES.TERMINAL_FREE
    && hasLockedArchive(storageSummary);
}

/**
 * Renders teaser rows for the locked archive preview.
 *
 * Purpose: keep row rendering restricted to the v1 teaser fields and never
 * reference hidden company, position, notes, salary, status, or history fields.
 *
 * @param {{ teasers: object[] }} props - Locked teaser rows from the API.
 * @returns {import('react').ReactElement} Teaser list markup.
 */
function LockedArchiveTeaserList({ teasers }) {
  if (teasers.length === 0) {
    return (
      <p className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-500">
        No archived applications were returned for this preview.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
      {teasers.map((teaser, index) => (
        <li key={teaser.id ?? index} className="px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">
                Archived application {index + 1}
              </p>
              <p className="text-xs text-gray-500">
                Created {formatArchiveTeaserDate(teaser.created_at)}
              </p>
            </div>
            <div className="text-left text-xs text-gray-500 sm:text-right">
              <p>Locked {formatArchiveTeaserDate(teaser.locked_at)}</p>
              <p>{formatLockedReason(teaser.locked_reason)}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders the second confirmation modal for deleting locked archive rows.
 *
 * Purpose: make the destructive action explicit before the API receives the
 * fixed confirmation body required by the locked bulk-delete route.
 *
 * @param {object} props - Modal props.
 * @param {number} props.lockedCount - Locked archive row count.
 * @param {number} props.activeCount - Current active row count.
 * @param {number} props.activeLimit - Free active row limit.
 * @param {Function} props.onConfirm - Confirm callback.
 * @param {Function} props.onClose - Dismiss callback.
 * @param {boolean} props.deleting - Whether delete is in flight.
 * @param {object|null} props.error - Normalized delete error.
 * @returns {import('react').ReactElement} Confirmation modal.
 */
function LockedArchiveDeleteModal({
  lockedCount,
  activeCount,
  activeLimit,
  onConfirm,
  onClose,
  deleting,
  error,
}) {
  /**
   * Closes the modal when the backdrop itself is clicked.
   *
   * Purpose: match the existing modal behavior while avoiding accidental close
   * during an in-flight destructive request.
   *
   * @param {MouseEvent} event - React click event.
   * @returns {void}
   */
  function handleOverlayClick(event) {
    if (!deleting && event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-5"
      role="dialog"
      aria-modal="true"
      onClick={handleOverlayClick}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900">Delete Locked Archive</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="text-2xl leading-none text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Close locked archive delete confirmation"
          >
            &times;
          </button>
        </div>

        <div className="space-y-3 text-sm text-gray-600">
          <p>
            Permanently delete {lockedCount} archived application{lockedCount === 1 ? '' : 's'}?
            This cannot be undone.
          </p>
          <p>
            Deleting locked applications does not restore add capacity if you still have
            {' '}{activeLimit} active applications. You currently have {activeCount} active.
          </p>
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error.message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="rounded border border-gray-300 bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {deleting ? 'Deleting...' : 'Permanently Delete Archive'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shows the locked archive entry point and teaser-only preview.
 *
 * Purpose: let downgraded users see archive size, inspect safe teaser metadata,
 * access the explicit CSV export path, and intentionally delete locked rows
 * without leaking hidden job fields.
 *
 * @param {{ storageSummary?: object|null, onArchiveDeleted?: Function|null }} props - Count metadata and refresh callback.
 * @returns {import('react').ReactElement|null} Archive panel or null.
 */
export default function LockedArchivePanel({ storageSummary = null, onArchiveDeleted = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [teasers, setTeasers] = useState([]);
  const [error, setError] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletingArchive, setDeletingArchive] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const deleteInFlightRef = useRef(false);
  const lockedCount = getStorageCount(storageSummary?.lockedCount);
  const activeCount = getStorageCount(storageSummary?.activeCount);
  const activeLimit = getStorageCount(storageSummary?.activeLimit);
  const showDeleteAction = canShowLockedArchiveDelete(storageSummary);

  useEffect(() => {
    if (!isOpen || hasLoaded || !hasLockedArchive(storageSummary)) {
      return undefined;
    }

    let isCancelled = false;

    /**
     * Loads the first page of locked teaser rows for the archive preview.
     *
     * Purpose: fetch from the validated locked archive route only after the
     * user opens the panel, keeping ordinary dashboard loads active-only.
     *
     * @returns {Promise<void>}
     */
    async function loadLockedArchivePreview() {
      setLoading(true);
      setError(null);

      const result = await api.get(LOCKED_ARCHIVE_PREVIEW_PATH);

      if (isCancelled) {
        return;
      }

      if (result.error || result.data?.error) {
        const errorData = result.data?.error
          ? { message: result.data?.message, code: result.data?.error }
          : result.error;
        setError(normalizeError(errorData, ERROR_MESSAGES.FETCH_FAILED));
        setTeasers([]);
        setHasLoaded(false);
        setLoading(false);
        return;
      }

      setTeasers(Array.isArray(result.data?.data?.data) ? result.data.data.data : []);
      setHasLoaded(true);
      setLoading(false);
    }

    loadLockedArchivePreview();

    return () => {
      isCancelled = true;
    };
  }, [hasLoaded, isOpen, storageSummary]);

  /**
   * Opens the destructive archive-delete confirmation modal.
   *
   * Purpose: keep the API confirmation behind a deliberate second click from
   * the archive panel rather than firing from the primary archive controls.
   *
   * @returns {void}
   */
  function openDeleteModal() {
    setDeleteError(null);
    setDeleteModalOpen(true);
  }

  /**
   * Closes the destructive archive-delete confirmation modal.
   *
   * Purpose: allow users to back out unless a delete request is already in
   * flight and the UI is waiting for the route response.
   *
   * @returns {void}
   */
  function closeDeleteModal() {
    if (!deletingArchive) {
      setDeleteModalOpen(false);
      setDeleteError(null);
    }
  }

  /**
   * Calls the locked bulk-delete API after second confirmation.
   *
   * Purpose: send the fixed confirmation token required by the route, normalize
   * public errors, clear stale teaser data on success, and refresh count-only
   * storage metadata through the parent dashboard hook.
   *
   * @returns {Promise<void>}
   */
  async function confirmDeleteLockedArchive() {
    if (deleteInFlightRef.current) {
      return;
    }

    deleteInFlightRef.current = true;
    setDeletingArchive(true);
    setDeleteError(null);

    let archiveDeletedData = null;
    let shouldNotifyArchiveDeleted = false;

    try {
      const result = await api.delete(LOCKED_ARCHIVE_DELETE_PATH, {
        confirmation: LOCKED_ARCHIVE_DELETE_CONFIRMATION,
      });

      if (result.error || result.data?.error) {
        const errorData = result.data?.error
          ? { message: result.data?.message, code: result.data?.error }
          : result.error;
        setDeleteError(normalizeError(errorData, ERROR_MESSAGES.DELETE_FAILED));
        return;
      }

      archiveDeletedData = result.data?.data ?? null;
      shouldNotifyArchiveDeleted = true;
      setTeasers([]);
      setHasLoaded(false);
      setIsOpen(false);
      setDeleteModalOpen(false);
    } catch (error) {
      setDeleteError(normalizeError(error, ERROR_MESSAGES.DELETE_FAILED));
    } finally {
      setDeletingArchive(false);
      deleteInFlightRef.current = false;
    }

    if (shouldNotifyArchiveDeleted && typeof onArchiveDeleted === 'function') {
      onArchiveDeleted(archiveDeletedData);
    }
  }

  if (!hasLockedArchive(storageSummary)) {
    return null;
  }

  return (
    <section className="mb-5 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Locked archive</h2>
          <p className="mt-1 text-sm text-gray-600">
            {lockedCount} archived application{lockedCount === 1 ? '' : 's'} are preserved outside
            your active dashboard.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            className="inline-flex items-center justify-center rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {isOpen ? 'Hide archive' : 'View archive'}
          </button>
          {/* This API navigation intentionally triggers a browser-managed CSV download. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/storage/export"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Export CSV
          </a>
          {showDeleteAction && (
            <button
              type="button"
              onClick={openDeleteModal}
              className="inline-flex items-center justify-center rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Delete Archive
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500">
            This preview shows archive dates only. Export CSV includes your full application data.
          </p>
          {showDeleteAction && (
            <p className="text-xs text-gray-500">
              Deleting locked applications is permanent and does not restore add capacity while
              your active applications are at the Free limit.
            </p>
          )}
          {loading && <p className="text-sm text-gray-500">Loading archive...</p>}
          {error && <p className="text-sm text-red-700">{error.message}</p>}
          {!loading && !error && <LockedArchiveTeaserList teasers={teasers} />}
          {!loading && !error && lockedCount > teasers.length && (
            <p className="text-xs text-gray-500">
              Showing {teasers.length} of {lockedCount} archived applications.
            </p>
          )}
        </div>
      )}

      {deleteModalOpen && (
        <LockedArchiveDeleteModal
          lockedCount={lockedCount}
          activeCount={activeCount}
          activeLimit={activeLimit}
          onConfirm={confirmDeleteLockedArchive}
          onClose={closeDeleteModal}
          deleting={deletingArchive}
          error={deleteError}
        />
      )}
    </section>
  );
}
