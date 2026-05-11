import { z } from 'zod';
import { BILLING_PLANS } from '../constants/billing.js';

const BILLING_PLAN_VALUES = Object.values(BILLING_PLANS);
const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9_]+$/;
const CHECKOUT_ATTEMPT_NONCE_PATTERN = /^[A-Fa-f0-9]{32}$/;

export const billingCheckoutSchema = z.object({
  plan: z.enum(BILLING_PLAN_VALUES, { error: 'Invalid billing plan' }),
  checkoutAttemptNonce: z.string()
    .trim()
    .regex(CHECKOUT_ATTEMPT_NONCE_PATTERN, 'Invalid checkout attempt nonce')
    .transform((nonce) => nonce.toLowerCase()),
}).strict();

export const billingCheckoutStatusSchema = z.object({
  sessionId: z.string()
    .trim()
    .min(1, 'Checkout session id is required')
    .max(255, 'Checkout session id is too long')
    .regex(STRIPE_CHECKOUT_SESSION_ID_PATTERN, 'Invalid checkout session id'),
});
