import { STORAGE_STATUSES } from '../../shared/constants/billing.js';

/**
 * Coerces API count fields into non-negative integers for UI copy.
 *
 * Purpose: storage summaries arrive from the API, so display logic should not
 * render NaN or negative values if a malformed response slips through.
 *
 * @param {unknown} value - Raw count-like value from storageSummary.
 * @returns {number} Safe non-negative integer count.
 */
export function getStorageCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Formats a storage/billing date for customer-facing downgrade copy.
 *
 * Purpose: dashboard and billing notices need the same exact-date rendering
 * while avoiding "Invalid Date" text for missing or malformed timestamps.
 *
 * @param {string|number|Date|null|undefined} value - Raw date-like value.
 * @returns {string|null} Localized date text, or null when unavailable.
 */
export function formatStorageDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Decides whether a summary can show scheduled-downgrade overflow copy.
 *
 * Purpose: only canceling Premium with positive projected overflow should show
 * the warning; ambiguous billing states must never receive confirmed-Free copy.
 *
 * @param {object|null|undefined} storageSummary - API storage summary.
 * @returns {boolean} True when the Premium-ending warning should render.
 */
export function shouldShowPremiumCancelingStorageWarning(storageSummary) {
  return storageSummary?.status === STORAGE_STATUSES.PREMIUM_CANCELING
    && Boolean(storageSummary.cancelAtPeriodEnd)
    && getStorageCount(storageSummary.projectedOverflowCount) > 0;
}

/**
 * Decides whether confirmed Free archive copy is allowed.
 *
 * Purpose: terminal Free is the only confirmed-Free state in v1; retryable,
 * payment-recovery, sync-pending, and non-terminal states must not show
 * downgrade-impact copy.
 *
 * @param {object|null|undefined} storageSummary - API storage summary.
 * @returns {boolean} True when terminal-Free archive copy can render.
 */
export function shouldShowTerminalFreeArchiveCopy(storageSummary) {
  if (storageSummary?.status !== STORAGE_STATUSES.TERMINAL_FREE) {
    return false;
  }

  return getStorageCount(storageSummary.lockedCount) > 0
    || getStorageCount(storageSummary.projectedOverflowCount) > 0;
}

/**
 * Checks whether a storage summary reports existing archived rows.
 *
 * Purpose: archive entry points depend only on count metadata and must not infer
 * archive state from ordinary job-list contents.
 *
 * @param {object|null|undefined} storageSummary - API storage summary.
 * @returns {boolean} True when at least one locked row exists.
 */
export function hasLockedArchive(storageSummary) {
  return getStorageCount(storageSummary?.lockedCount) > 0;
}
