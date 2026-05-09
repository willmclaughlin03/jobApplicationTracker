const {
  BILLING_PAGE_LOAD_STATES,
  canOpenPortalFromLocalStatus,
  canStartCheckoutFromLocalStatus,
  getBillingStatusSummary,
} = require('../billingPageState.js');
const { BILLING_SUBSCRIPTION_STATUSES } = require('../../../shared/constants/billing.js');

describe('billingPageState', () => {
  describe('getBillingStatusSummary', () => {
    it('returns explicit unavailable copy when the billing status read failed', () => {
      expect(
        getBillingStatusSummary({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.ERROR,
        })
      ).toEqual({
        title: 'Billing status unavailable',
        description: 'We could not verify your local billing state right now. Refresh this page before starting checkout or opening the billing portal.',
      });
    });

    it('returns loading copy only while the billing status is still being fetched', () => {
      expect(
        getBillingStatusSummary({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.LOADING,
        })
      ).toEqual({
        title: 'Loading billing status',
        description: 'Checking your local billing state.',
      });
    });
  });

  describe('canStartCheckoutFromLocalStatus', () => {
    it('fails closed while the billing status is loading or unavailable', () => {
      expect(
        canStartCheckoutFromLocalStatus({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.LOADING,
        })
      ).toBe(false);

      expect(
        canStartCheckoutFromLocalStatus({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.ERROR,
        })
      ).toBe(false);
    });

    it('allows checkout only for ready states with no subscription or restartable statuses', () => {
      expect(
        canStartCheckoutFromLocalStatus({
          billingStatus: { hasSubscription: false },
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toBe(true);

      expect(
        canStartCheckoutFromLocalStatus({
          billingStatus: {
            hasSubscription: true,
            status: BILLING_SUBSCRIPTION_STATUSES.CANCELED,
          },
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toBe(true);

      expect(
        canStartCheckoutFromLocalStatus({
          billingStatus: {
            hasSubscription: true,
            status: BILLING_SUBSCRIPTION_STATUSES.ACTIVE,
          },
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toBe(false);
    });
  });

  describe('canOpenPortalFromLocalStatus', () => {
    it('requires a ready state and a confirmed portal-capable Stripe customer id', () => {
      expect(
        canOpenPortalFromLocalStatus({
          billingStatus: { hasPortalCustomer: true },
          loadState: BILLING_PAGE_LOAD_STATES.LOADING,
        })
      ).toBe(false);

      expect(
        canOpenPortalFromLocalStatus({
          billingStatus: {
            hasCustomerMapping: true,
            hasPortalCustomer: false,
          },
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toBe(false);

      expect(
        canOpenPortalFromLocalStatus({
          billingStatus: { hasPortalCustomer: true },
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toBe(true);
    });
  });
});
