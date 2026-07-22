import Link from 'next/link';
import {
  formatStorageDate,
  getStorageCount,
  shouldShowPremiumCancelingStorageWarning,
} from '../lib/storageSummaryUi.js';

/**
 * Renders the scheduled Premium downgrade warning for over-Free-limit users.
 *
 * Purpose: warn canceling Premium users before their paid period ends, using
 * count-only storageSummary metadata rather than locked job details.
 *
 * @param {{ storageSummary?: object|null }} props - Dashboard storage metadata.
 * @returns {import('react').ReactElement|null} Warning banner or null.
 */
export default function StorageDowngradeBanner({ storageSummary = null }) {
  if (!shouldShowPremiumCancelingStorageWarning(storageSummary)) {
    return null;
  }

  const activeLimit = getStorageCount(storageSummary.activeLimit);
  const activeCount = getStorageCount(storageSummary.activeCount);
  const overflowCount = getStorageCount(storageSummary.projectedOverflowCount);
  const periodEnd = formatStorageDate(storageSummary.currentPeriodEnd) ?? 'your current period end';

  return (
    <section
      role="status"
      aria-live="polite"
      className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Premium storage ending</h2>
          <p className="mt-1 text-sm leading-6">
            Your Premium plan ends on {periodEnd}. Free accounts can keep {activeLimit} active
            applications. You currently have {activeCount}. If you do not renew, {overflowCount}
            {' '}applications will move to a locked archive. Nothing will be deleted.
          </p>
        </div>
        <Link
          href="/billing"
          className="inline-flex shrink-0 items-center justify-center rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
        >
          Review billing
        </Link>
      </div>
    </section>
  );
}
