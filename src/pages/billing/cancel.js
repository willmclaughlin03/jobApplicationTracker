import Link from 'next/link';

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
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <p className="text-sm uppercase tracking-wide text-blue-600 font-semibold">
          Billing
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-gray-900">Checkout was canceled</h1>
        <p className="mt-3 text-gray-600">
          No entitlement changes were granted from the redirect alone. You can return to billing whenever you are ready to try again.
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/billing"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Back to billing
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
