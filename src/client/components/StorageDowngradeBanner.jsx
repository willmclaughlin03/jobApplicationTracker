import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
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
      className="mb-5 rounded-dashboard-panel border border-amber-400/55 bg-amber-500/10 px-4 py-3 text-amber-100 shadow-lg"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-400/50 bg-amber-500/15 text-amber-200">
            <TriangleAlert aria-hidden="true" size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-amber-100">Premium storage ending</h2>
            <p className="mt-1 text-sm leading-6 text-amber-100/90">
              Your Premium plan ends on {periodEnd}. Free accounts can keep {activeLimit} active
              applications. You currently have {activeCount}. If you do not renew, {overflowCount}
              {' '}applications will move to a locked archive. Nothing will be deleted.
            </p>
          </div>
        </div>
        <Link
          href="/billing"
          className="dashboard-focus-ring inline-flex min-h-9 shrink-0 items-center justify-center rounded-dashboard-control border border-amber-400/60 bg-dashboard-surface-raised px-3 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-500/15"
        >
          Review billing
        </Link>
      </div>
    </section>
  );
}
