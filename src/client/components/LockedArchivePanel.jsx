import { useEffect, useId, useRef, useState } from 'react';
import { Archive, ChevronDown, Download, Trash2, TriangleAlert, X } from 'lucide-react';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility.js';
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
      <p className="rounded-dashboard-control border border-dashboard-line bg-dashboard-canvas/60 px-3 py-2 text-sm text-dashboard-muted">
        No archived applications were returned for this preview.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-dashboard-line rounded-dashboard-control border border-dashboard-line bg-dashboard-canvas/45">
      {teasers.map((teaser, index) => (
        <li key={teaser.id} className="px-3 py-2.5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-dashboard-text">
                Archived application {index + 1}
              </p>
              <p className="text-xs text-dashboard-muted">
                Created {formatArchiveTeaserDate(teaser.created_at)}
              </p>
            </div>
            <div className="text-left text-xs text-dashboard-muted sm:text-right">
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
  const titleId = useId();
  const descriptionId = useId();
  const { containerRef } = useOverlayAccessibility(true, onClose);

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
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[#010907]/85 p-4 sm:p-5"
      onClick={handleOverlayClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={deleting || undefined}
        tabIndex={-1}
        className="dashboard-raised-panel w-full max-w-md p-4 text-dashboard-text sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-400/40 bg-red-500/10 text-red-300">
              <TriangleAlert aria-hidden="true" size={20} />
            </span>
            <h2 id={titleId} className="text-lg font-semibold text-dashboard-text">
              Delete Locked Archive
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="dashboard-focus-ring inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-dashboard-control text-dashboard-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Close locked archive delete confirmation"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        <div id={descriptionId} className="space-y-3 border-y border-dashboard-line py-4 text-sm text-dashboard-muted">
          <p>
            Permanently delete {lockedCount} archived application{lockedCount === 1 ? '' : 's'}?
            <span className="font-medium text-red-300"> This cannot be undone.</span>
          </p>
          <div className="flex items-start gap-2 rounded-dashboard-control border border-amber-400/45 bg-amber-500/10 px-3 py-2 text-amber-100">
            <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
            <p>
              <span className="font-medium">Capacity warning:</span> Deleting locked applications
              does not restore add capacity if you still have {activeLimit} active applications.
              You currently have {activeCount} active.
            </p>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-dashboard-control border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error.message}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="dashboard-control dashboard-focus-ring min-h-9 px-4 py-2 text-sm font-medium text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="dashboard-focus-ring min-h-9 rounded-dashboard-control border border-red-400/70 bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
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
  const archiveContentId = useId();
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
    <section className="dashboard-major-panel mb-5 rounded-dashboard-panel bg-dashboard-surface/95 px-4 py-3 text-dashboard-text">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashboard-control-border bg-dashboard-active text-dashboard-accent-hover">
            <Archive aria-hidden="true" size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-dashboard-text">Locked archive</h2>
            <p className="mt-1 text-sm text-dashboard-muted">
              {lockedCount} archived application{lockedCount === 1 ? ' is' : 's are'} preserved
              outside your active dashboard.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            aria-expanded={isOpen}
            aria-controls={archiveContentId}
            className="dashboard-control dashboard-focus-ring inline-flex min-h-9 items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover"
          >
            {isOpen ? 'Hide archive' : 'View archive'}
            <ChevronDown
              aria-hidden="true"
              size={16}
              className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {/* This API navigation intentionally triggers a browser-managed CSV download. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/storage/export"
            className="dashboard-focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-dashboard-control border border-dashboard-accent/60 bg-dashboard-active px-3 py-2 text-sm font-medium text-dashboard-accent-hover transition-colors hover:bg-dashboard-surface-hover"
          >
            <Download aria-hidden="true" size={16} />
            Export CSV
          </a>
          {showDeleteAction && (
            <button
              type="button"
              onClick={openDeleteModal}
              className="dashboard-focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-dashboard-control border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:border-red-300/70 hover:bg-red-500/20"
            >
              <Trash2 aria-hidden="true" size={16} />
              Delete Archive
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div id={archiveContentId} className="mt-3 space-y-3 border-t border-dashboard-line pt-3">
          <p className="text-xs text-dashboard-muted">
            This preview shows archive dates only. Export CSV includes your full application data.
          </p>
          {showDeleteAction && (
            <p className="rounded-dashboard-control border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              <span className="font-medium">Capacity warning:</span>{' '}
              Deleting locked applications is permanent and does not restore add capacity while
              your active applications are at the Free limit.
            </p>
          )}
          {loading && (
            <p role="status" aria-live="polite" className="text-sm text-dashboard-muted">
              Loading archive...
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-dashboard-control border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error.message}
            </p>
          )}
          {!loading && !error && <LockedArchiveTeaserList teasers={teasers} />}
          {!loading && !error && lockedCount > teasers.length && (
            <p className="text-xs text-dashboard-muted">
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
