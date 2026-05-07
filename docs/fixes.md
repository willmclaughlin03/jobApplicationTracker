# Fixes

Use this file to briefly record fixes after every `git push`.

## What to record
- Briefly describe the issue that was addressed.
- Note the approach taken to fix it.
- Summarize how the fix was implemented.
- Add the date so the fix history stays readable.

## Entry Template
- `YYYY-MM-DD` - `Issue name`: issue summary. Approach: short note on the strategy used. Fix: short note on how it was resolved.

## Entries
- `2026-05-06` - `Billing Stage 4 polling and checkout hardening`: Billing checkout retries could reuse stale Checkout Session URLs, success-page polling could overrun the billing-write quota or ignore server cooldowns, checkout-status retried too broadly, and mapped Stripe-customer email syncs were doing avoidable no-op provider updates. Approach: tighten the shared billing contracts at the schema, route, and client-helper layers; make the Stripe runtime and checkout-status retry behavior explicit; add a best-effort local email fingerprint optimization; and bundle the Stage 4 billing routes/pages with the new hardening changes on one branch. Fix: raised the `billing_write` quotas, replaced hour-bucket checkout idempotency with a validated client nonce, collapsed valid-session ownership failures, added explicit Stripe timeout/retry config and app-origin credential rejection, extended `apiRequest` with response metadata for `Retry-After`, added cooldown-aware success-page polling/refresh helpers, kept billing redirect loading latched until handoff, added the `012_billing_customer_email_fingerprint.sql` migration plus fingerprint-backed Stripe email dedupe, and refreshed the focused Jest coverage and docs.
- `2026-04-30` - `Billing customer email sync hardening`: Stripe customer warning logs could include full provider error objects, the email sync helper lacked module-style documentation, and a post-upsert mapped-customer race path skipped the best-effort email sync. Approach: tighten the logging payload to safe primitives, document the helper's side effects and return behavior, and align the race branch with the other mapped-customer email-sync paths while adding regression coverage. Fix: `billingService.js` now logs a sanitized `{ name, code, message }` error shape, documents `syncStripeCustomerEmail` with repo-style JSDoc, and syncs email before returning from the post-upsert mapped-customer branch; the billing service Jest suite now covers the race-path email sync and the sanitized warning payload.
- `2026-04-30` - `Fix log created`: Established the shared post-push fix log. Approach: created a lightweight markdown tracker. Fix: added a standard place to record issues, approaches, and resolutions after each push.
- `2026-04-30` - `Billing hardening narrowed follow-up`: Stripe customer creation could deadlock on retries when the idempotent create payload changed with email input, and delete-event billing writes could overwrite newer local state by merging stale fields. Approach: keep the Stripe customer create call byte-stable, move email sync into a separate best-effort update, and treat delete snapshots as event-derived writes guarded by small future-timestamp validation. Fix: `billingService.js` now creates customers with a stable empty payload and syncs email separately, delete events no longer merge local subscription fields into the RPC payload, future event timestamps beyond five minutes are rejected, stale outcomes use the write enum consistently, and the billing unit suite covers the new behavior.
