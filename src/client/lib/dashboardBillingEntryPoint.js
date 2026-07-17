import { STORAGE_STATUSES } from '../../shared/constants/billing.js';

export const DASHBOARD_BILLING_ENTRY_ACTIONS = Object.freeze({
  OPEN_UPGRADE_MODAL: 'open_upgrade_modal',
  NAVIGATE_BILLING: 'navigate_billing',
});

const UPGRADE_ENTRY_POINT = Object.freeze({
  label: 'Upgrade',
  action: DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL,
});
const MANAGE_PLAN_ENTRY_POINT = Object.freeze({
  label: 'Manage plan',
  action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
});
const BILLING_ENTRY_POINT = Object.freeze({
  label: 'Billing',
  action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
});

/**
 * Resolve the dashboard billing control for one storage-summary status.
 *
 * Purpose: only terminal Free may open the upgrade modal. Known subscription
 * states route to plan management, while transitional, missing, and unknown
 * values fail closed to the canonical Billing page without performing routing.
 *
 * @param {unknown} status - Presentation-only storage status from the dashboard summary.
 * @returns {{ label: string, action: 'open_upgrade_modal' | 'navigate_billing' }} Frozen UI action descriptor.
 */
export function getDashboardBillingEntryPoint(status) {
  switch (status) {
    case STORAGE_STATUSES.TERMINAL_FREE:
      return UPGRADE_ENTRY_POINT;
    case STORAGE_STATUSES.PREMIUM_ACTIVE:
    case STORAGE_STATUSES.PREMIUM_CANCELING:
    case STORAGE_STATUSES.PAYMENT_RECOVERY:
      return MANAGE_PLAN_ENTRY_POINT;
    case STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING:
    case STORAGE_STATUSES.SYNC_PENDING:
    case STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL:
    case STORAGE_STATUSES.BILLING_UNAVAILABLE:
    default:
      return BILLING_ENTRY_POINT;
  }
}
