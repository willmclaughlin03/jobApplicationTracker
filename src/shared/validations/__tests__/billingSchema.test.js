const { BILLING_PLANS } = require('../../constants/billing.js');
const {
  billingCheckoutSchema,
  billingCheckoutStatusSchema,
} = require('../billingSchema.js');

describe('billingSchema', () => {
  describe('billingCheckoutSchema', () => {
    it('accepts the supported billing plan', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: '0123456789abcdef0123456789abcdef',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: '0123456789abcdef0123456789abcdef',
      });
    });

    it('rejects unknown billing plans', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: 'unknown_plan',
        checkoutAttemptNonce: '0123456789abcdef0123456789abcdef',
      });

      expect(result.success).toBe(false);
    });

    it('rejects a missing checkout attempt nonce', () => {
      const result = billingCheckoutSchema.safeParse({
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      });

      expect(result.success).toBe(false);
    });

    it('rejects checkout attempt nonces that are not exactly 32 lowercase hex characters', () => {
      expect(
        billingCheckoutSchema.safeParse({
          plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
          checkoutAttemptNonce: 'short',
        }).success
      ).toBe(false);

      expect(
        billingCheckoutSchema.safeParse({
          plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
          checkoutAttemptNonce: '0123456789abcdef0123456789abcdeg',
        }).success
      ).toBe(false);

      expect(
        billingCheckoutSchema.safeParse({
          plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
          checkoutAttemptNonce: '0123456789ABCDEF0123456789ABCDEF',
        }).success
      ).toBe(false);
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
