import { applyProtectedPageCache } from '../../server/lib/protectedPageCache.js';

/**
 * Opt this protected shell into request-time rendering and prevent CDN storage.
 * Middleware and existing client/API guards retain their authentication duties;
 * no user data or credentials are serialized into props by this cache boundary.
 * @param {import('next').GetServerSidePropsContext} context - Page response.
 * @returns {Promise<{props: object}>} Empty props for the existing client shell.
 */
export async function getServerSideProps({ res }) {
  applyProtectedPageCache(res);
  return { props: {} };
}

import Link from 'next/link';
import { ArrowRight, CircleX } from 'lucide-react';
import PublicPageShell, {
  PUBLIC_PRIMARY_ACTION_CLASS_NAME,
  PUBLIC_SECONDARY_ACTION_CLASS_NAME,
} from '../../client/components/public/PublicPageShell';

/**
 * Render the billing checkout cancel redirect page.
 *
 * Purpose: show a fail-closed cancellation state after Stripe sends a user
 * back through /billing/cancel without granting entitlement from the redirect
 * alone.
 *
 * Dependencies:
 * - Next.js Link for route-safe navigation back to /billing and the dashboard.
 * - /api/billing/checkout configures Stripe Checkout with this page as the
 *   cancelUrl, so the copy stays tied to the billing redirect flow.
 *
 * Params:
 * - none; this page component does not receive props or route params.
 *
 * Returns:
 * - static JSX for the cancellation message and navigation links.
 * - no API calls, auth context updates, or entitlement side effects.
 */
export default function BillingCancelPage() {
  return (
    <PublicPageShell contentTestId="billing-cancel-panel">
      <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-dashboard-panel border border-dashboard-line bg-dashboard-surface/60 text-dashboard-muted">
        <CircleX aria-hidden="true" size={24} strokeWidth={1.6} />
      </div>
      <p className="text-dashboard-caption font-semibold uppercase tracking-wider text-dashboard-accent">
        Billing
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-dashboard-text sm:text-[1.75rem] sm:leading-9">Checkout was canceled</h1>
      <p className="mt-3 text-dashboard-body leading-6 text-dashboard-muted">
        Checkout was not completed. You can return to billing whenever you are ready to try again.
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <Link
          href="/billing"
          className={[PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'justify-center gap-3'].join(' ')}
        >
          Back to billing
          <ArrowRight aria-hidden="true" size={16} className="text-dashboard-accent" />
        </Link>
        <Link
          href="/"
          className={PUBLIC_SECONDARY_ACTION_CLASS_NAME}
        >
          Dashboard
        </Link>
      </div>
    </PublicPageShell>
  );
}
