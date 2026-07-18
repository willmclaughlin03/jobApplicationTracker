const {
  BILLING_ENTITLEMENTS,
  BILLING_PLANS,
  BILLING_SUBSCRIPTION_STATUSES,
} = require('../../constants/billing.js');
const {
  billingCheckoutSchema,
  billingCheckoutStatusSchema,
  billingStatusSchema,
} = require('../billingSchema.js');

describe('billingSchema', () => {
  const validCheckoutAttemptNonce = '0123456789abcdef0123456789abcdef';
  const validFreeBillingStatus = Object.freeze({
    entitled: false,
    entitlement: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasCustomerMapping: false,
    hasPortalCustomer: false,
    hasSubscription: false,
  });

  describe('billingStatusSchema', () => {
    it('accepts complete canonical free and subscribed snapshots', () => {
      expect(billingStatusSchema.safeParse(validFreeBillingStatus).success).toBe(true);
      expect(billingStatusSchema.safeParse({
        ...validFreeBillingStatus,
        entitled: true,
        entitlement: BILLING_ENTITLEMENTS.PREMIUM,
        status: BILLING_SUBSCRIPTION_STATUSES.ACTIVE,
        currentPeriodEnd: '2026-08-18T12:00:00.000Z',
        hasCustomerMapping: true,
        hasPortalCustomer: true,
        hasSubscription: true,
      }).success).toBe(true);
    });

    it.each([
      ['an empty object', {}],
      ['an incomplete object', { hasSubscription: false }],
      ['a non-boolean subscription flag', {
        ...validFreeBillingStatus,
        hasSubscription: 'false',
      }],
      ['an unknown subscription status', {
        ...validFreeBillingStatus,
        status: 'trialing',
        hasSubscription: true,
      }],
      ['a missing status for an existing subscription', {
        ...validFreeBillingStatus,
        hasSubscription: true,
      }],
      ['a subscription status without an existing subscription', {
        ...validFreeBillingStatus,
        status: BILLING_SUBSCRIPTION_STATUSES.CANCELED,
      }],
    ])('rejects %s', (_label, billingStatus) => {
      expect(billingStatusSchema.safeParse(billingStatus).success).toBe(false);
    });
  });

  describe('billingCheckoutSchema', () => {
    it('accepts the supported billing plan and checkout attempt nonce', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
        checkoutAttemptNonce: validCheckoutAttemptNonce,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
        checkoutAttemptNonce: validCheckoutAttemptNonce,
      });
    });

    it('normalizes uppercase checkout attempt nonces', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
        checkoutAttemptNonce: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
      });

      expect(result.success).toBe(true);
      expect(result.data.checkoutAttemptNonce).toBe('abcdefabcdefabcdefabcdefabcdefab');
    });

    it('rejects unknown billing plans', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: 'unknown_plan',
        checkoutAttemptNonce: validCheckoutAttemptNonce,
      });

      expect(result.success).toBe(false);
    });

    it('rejects missing billing plans', () => {
      const result = billingCheckoutSchema.safeParse({
        checkoutAttemptNonce: validCheckoutAttemptNonce,
      });

      expect(result.success).toBe(false);
    });

    it('rejects missing checkout attempt nonces', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
      });

      expect(result.success).toBe(false);
    });

    it('rejects malformed checkout attempt nonces', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
        checkoutAttemptNonce: 'not-a-valid-nonce',
      });

      expect(result.success).toBe(false);
    });

    it('rejects checkout request fields outside the strict nonce-backed contract', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.PREMIUM_MONTHLY,
        checkoutAttemptNonce: validCheckoutAttemptNonce,
        clientSessionId: 'extra-session-field',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('billingCheckoutStatusSchema', () => {
    it('accepts a Stripe Checkout Session id', () => {
      const result = billingCheckoutStatusSchema.safeParse({
        sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT',
      });

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('cs_test_a1Ae6ClgOkjygKwrf9B3L6IT');
    });

    it('trims the session id before returning it', () => {
      const result = billingCheckoutStatusSchema.safeParse({
        sessionId: '  cs_live_1234567890abcdef  ',
      });

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('cs_live_1234567890abcdef');
    });

    it('rejects malformed checkout session ids', () => {
      const result = billingCheckoutStatusSchema.safeParse({
        sessionId: 'sess_123',
      });

      expect(result.success).toBe(false);
    });
  });
});
