import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatStorageDate, getStorageCount, hasLockedArchive } from '../lib/storageSummaryUi.js';
import { normalizeError, ERROR_MESSAGES } from '../../shared/errors.js';

const LOCKED_ARCHIVE_PREVIEW_PATH = '/api?storage_state=locked&from=0&to=14';

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
 * Shows the locked archive entry point and teaser-only preview.
 *
 * Purpose: let downgraded users see archive size, inspect safe teaser metadata,
 * and access the explicit CSV export path without leaking hidden job fields.
 *
 * @param {{ storageSummary?: object|null }} props - Count-only storage metadata.
 * @returns {import('react').ReactElement|null} Archive panel or null.
 */
export default function LockedArchivePanel({ storageSummary = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [teasers, setTeasers] = useState([]);
  const [error, setError] = useState(null);
  const lockedCount = getStorageCount(storageSummary?.lockedCount);

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
          <a
            href="/api/storage/export"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Export CSV
          </a>
        </div>
      </div>

      {isOpen && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500">
            This preview shows archive dates only. Export CSV includes your full application data.
          </p>
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
    </section>
  );
}
