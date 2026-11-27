const {
  BILLING_PAGE_LOAD_STATES,
  canOpenPortalFromLocalStatus,
  canStartCheckoutFromLocalStatus,
  getBillingStatusSummary,
} = require('../billingPageState.js');
const { BILLING_SUBSCRIPTION_STATUSES } = require('../../../shared/constants/billing.js');

describe('billingPageState', () => {
  describe('getBillingStatusSummary', () => {
    it('explains baseline Free access after an abandoned upgrade', () => {
      expect(getBillingStatusSummary({
        billingStatus: { hasCustomerMapping: true, hasSubscription: false, entitled: false },
        loadState: BILLING_PAGE_LOAD_STATES.READY,
      })).toEqual({
        title: 'No active subscription',
        description: 'Free features remain available. Start checkout whenever you are ready to upgrade.',
      });
    });

    it('allows a fresh upgrade and explains Free access after initial payment expiry', () => {
      const input = {
        billingStatus: {
          hasSubscription: true,
          entitled: false,
          status: BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE_EXPIRED,
        },
        loadState: BILLING_PAGE_LOAD_STATES.READY,
      };
      expect(getBillingStatusSummary(input)).toEqual({
        title: 'Previous checkout expired',
        description: 'The last checkout attempt did not complete in time. Free features remain available, and you can try again.',
      });
      expect(canStartCheckoutFromLocalStatus(input)).toBe(true);
    });

    it('returns explicit unavailable copy when the billing status read failed', () => {
      expect(
        getBillingStatusSummary({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.ERROR,
        })
      ).toEqual({
        title: 'Billing status unavailable',
        description: 'We could not verify your subscription right now. Refresh this page before starting checkout or opening the billing portal.',
      });
    });

    it('returns unavailable copy when a ready state has no billing status snapshot', () => {
      expect(
        getBillingStatusSummary({
          billingStatus: null,
          loadState: BILLING_PAGE_LOAD_STATES.READY,
        })
      ).toEqual({
        title: 'Billing status unavailable',
        description: 'We could not verify your subscription right now. Refresh this page before starting checkout or opening the billing portal.',
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
        description: 'Checking your subscription details.',
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
