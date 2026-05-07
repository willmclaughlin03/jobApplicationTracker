import { z } from 'zod';
import { BILLING_PLANS } from '../constants/billing.js';

const BILLING_PLAN_VALUES = Object.values(BILLING_PLANS);
const BILLING_CHECKOUT_ATTEMPT_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9_]+$/;

export const billingCheckoutSchema = z.object({
  plan: z.enum(BILLING_PLAN_VALUES, { error: 'Invalid billing plan' }),
  checkoutAttemptNonce: z.string()
    .length(32, 'Checkout attempt nonce must be exactly 32 characters')
    .regex(
      BILLING_CHECKOUT_ATTEMPT_NONCE_PATTERN,
      'Checkout attempt nonce must be lowercase hex'
    ),
});

export const billingCheckoutStatusSchema = z.object({
  sessionId: z.string()
    .trim()
    .min(1, 'Checkout session id is required')
    .max(255, 'Checkout session id is too long')
    .regex(STRIPE_CHECKOUT_SESSION_ID_PATTERN, 'Invalid checkout session id'),
});
