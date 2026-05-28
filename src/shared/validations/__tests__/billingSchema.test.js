const { BILLING_PLANS } = require('../../constants/billing.js');
const {
  billingCheckoutSchema,
  billingCheckoutStatusSchema,
} = require('../billingSchema.js');

describe('billingSchema', () => {
  const validCheckoutAttemptNonce = '0123456789abcdef0123456789abcdef';

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
