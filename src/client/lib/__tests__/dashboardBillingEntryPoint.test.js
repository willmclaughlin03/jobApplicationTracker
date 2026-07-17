const {
  DASHBOARD_BILLING_ENTRY_ACTIONS,
  getDashboardBillingEntryPoint,
} = require('../dashboardBillingEntryPoint.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');

const EXPECTED_ENTRY_POINTS = {
  [STORAGE_STATUSES.TERMINAL_FREE]: {
    label: 'Upgrade',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.OPEN_UPGRADE_MODAL,
  },
  [STORAGE_STATUSES.PREMIUM_ACTIVE]: {
    label: 'Manage plan',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.PREMIUM_CANCELING]: {
    label: 'Manage plan',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.PAYMENT_RECOVERY]: {
    label: 'Manage plan',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING]: {
    label: 'Billing',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.SYNC_PENDING]: {
    label: 'Billing',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL]: {
    label: 'Billing',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
  [STORAGE_STATUSES.BILLING_UNAVAILABLE]: {
    label: 'Billing',
    action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
  },
};

describe('dashboardBillingEntryPoint', () => {
  it('maps every canonical storage status to the approved entry point', () => {
    expect(Object.keys(EXPECTED_ENTRY_POINTS).sort()).toEqual(
      Object.values(STORAGE_STATUSES).sort()
    );

    for (const [status, expectedEntryPoint] of Object.entries(EXPECTED_ENTRY_POINTS)) {
      expect(getDashboardBillingEntryPoint(status)).toEqual(expectedEntryPoint);
    }
  });

  it.each([
    undefined,
    null,
    '',
    'unknown_status',
    '__proto__',
    'constructor',
    42,
    {},
  ])('fails closed to Billing navigation for unknown status %p', (status) => {
    expect(getDashboardBillingEntryPoint(status)).toEqual({
      label: 'Billing',
      action: DASHBOARD_BILLING_ENTRY_ACTIONS.NAVIGATE_BILLING,
    });
  });

  it('returns frozen action contracts without routing side effects', () => {
    expect(Object.isFrozen(DASHBOARD_BILLING_ENTRY_ACTIONS)).toBe(true);
    expect(Object.isFrozen(
      getDashboardBillingEntryPoint(STORAGE_STATUSES.TERMINAL_FREE)
    )).toBe(true);
    expect(Object.isFrozen(getDashboardBillingEntryPoint())).toBe(true);
  });
});
