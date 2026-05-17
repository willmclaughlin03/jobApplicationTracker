# Patches

You are working in c:\Users\willm\job-application-tracker as a security/logic implementation agent.

Goal:
Fix the verified Stripe/billing issues without causing architectural drift, then update docs/stripe-next-phase-plan.md so future agents understand the corrected design. Do not implement the full Chunk 5 webhook route unless explicitly asked; this task is foundation hardening plus plan correction.

Repo rules:
- Do not read .env files.
- Do not log secrets or env values.
- Preserve the existing API response envelope.
- Preserve “local billing state is canonical” for entitlement.
- Do not add admin billing bypasses.
- Do not widen billing entitlement statuses. `trialing` must remain unsupported.
- Use existing patterns and tests. Keep edits scoped.
- Update docs/feature-memory.md when complete.

Start by reading:
- AGENTS.md
- docs/stripe-next-phase-plan.md
- docs/stripe-architecture.md
- src/server/lib/stripe.js
- src/server/lib/billingService.js
- src/server/lib/webhookSignature.js
- src/server/lib/readRawBody.js
- src/server/middleware/withWebhookAuth.js
- src/server/lib/supabaseServer.js
- src/server/middleware/withRateLimit.js
- src/pages/api/billing/checkout.js
- src/pages/api/billing/checkout-status.js
- src/shared/validations/billingSchema.js
- relevant tests under:
  - src/server/lib/__tests__/
  - src/server/middleware/__tests__/
  - src/server/api/__tests__/billing/

Implement these fixes in this order.

1. Decouple webhook/local billing imports from checkout-only Stripe config

Problem:
`billingService.js` imports `stripe.js` at module load, and `webhookSignature.js` imports `stripe.js`. But `stripe.js` validates `NEXT_PUBLIC_APP_URL` and price env vars at import time. This means local billing reads and future webhook verification can crash because of unrelated checkout config.

Fix:
Create a narrow runtime module, for example `src/server/lib/stripeRuntime.js`.

It should own:
- `STRIPE_API_VERSION`
- `inferStripeMode(secretKey)`
- memoized `getConfiguredStripeMode()`
- memoized `getStripeClient()`
- dynamic `getActiveStripeWebhookSecret()`

Important details:
- `getConfiguredStripeMode()` must memoize after first successful resolution.
- `getStripeClient()` must memoize after first successful creation.
- Missing/malformed `STRIPE_SECRET_KEY` should throw consistently. If you cache config errors, expose a test-only reset helper with a runtime `process.env.NODE_ENV === 'test'` assertion.
- Add `__resetForTests()` or equivalent so tests can reset cached mode/client/error state. Security warning: the helper must throw outside `NODE_ENV=test`, must carry a test-only docstring/comment, and must never be imported or called by production code.
- The reset helper must clear cached successful mode/client state and cached error state if errors are memoized; otherwise tests can become order-sensitive.
- Do not memoize `getActiveStripeWebhookSecret()`. Webhook secrets should be read from `process.env` each call to support rotation.
- Do not validate `NEXT_PUBLIC_APP_URL` or price ids in this runtime module.
- Runtime mode/client validation should happen only when functions are called, not when local billing read helpers are imported.

Keep `src/server/lib/stripe.js` as the checkout/portal-facing module:
- still validate `NEXT_PUBLIC_APP_URL` and allowlisted price ids at module init
- still export existing checkout-facing helpers such as `stripe`, `buildAppUrl()`, `getPriceIdForPlan()`
- internally it may import from `stripeRuntime.js`

Update:
- `webhookSignature.js` should import from `stripeRuntime.js`, not `stripe.js`
- `billingService.js` should not import `stripe.js`
- Stripe API calls inside billing service should call `getStripeClient()` inside functions that actually call Stripe
- It is acceptable for `stripe.js` to keep exporting a checkout-facing `stripe` client, but do not let that preserve a `billingService.js` module-load import of checkout config.
- local-only reads like `getLocalBillingStatus()` and `resolveStorageEntitlement()` must not require app URL or price env config at import

Tests:
- `getConfiguredStripeMode()` returns cached mode across calls without re-reading env; mutate `process.env.STRIPE_SECRET_KEY` after first call and assert cached value still wins.
- missing key throws on first call and second call with the same error behavior/reference, unless reset.
- `__resetForTests()` clears cached mode/client/errors.
- webhook signature tests prove verifier does not need `NEXT_PUBLIC_APP_URL` or price env vars.
- Do not "fix" webhook signature tests by seeding `NEXT_PUBLIC_APP_URL`; the corrected contract is that webhook verification works with only Stripe secret/webhook-secret config and does not require checkout app URL or price env vars.
- checkout Stripe config tests still prove checkout config fails fast when app URL or price id is missing.

1. Enforce webhook raw-body caps consistently

Problem:
`readRawBody()` returns cached `req.rawBody` Buffers without checking length. Also `withWebhookAuth` accepts `maxBodyBytes`, but it does not pass it into `verifyWebhookSignature()` / `readRawBody()`.

Fix:
- In `readRawBody()`, if `req.rawBody` is a Buffer, reject when `length > maxBytes`.
- Update `verifyWebhookSignature(req, options)` to pass `options.maxBodyBytes` into `readRawBody(req, { maxBytes: options.maxBodyBytes })`.
- Update `withWebhookAuth()` to call:
  `verifySignature(req, { signature, signatureHeader, maxBodyBytes })`.
- Keep Content-Length as an early advisory check only.

Tests:
- oversized cached Buffer rejects with `RAW_BODY_TOO_LARGE`.
- custom `maxBodyBytes` is enforced during stream buffering.
- middleware maps raw-body oversize to `413 PAYLOAD_TOO_LARGE`.

1. Return 503 for Supabase auth backend outages

Problem:
`getUserFromRequest()` currently distinguishes “Authentication service unavailable” only in text, and `withRateLimit()` maps every no-user path to `401`.

Fix:
Add a helper in `supabaseServer.js`, e.g. `classifyAuthError(error)`:
- `status === 401 || status === 403` -> `AUTH_INVALID`
- `status === 429` -> `AUTH_UNAVAILABLE`
- `status >= 500` -> `AUTH_UNAVAILABLE`
- `name === 'AuthRetryableFetchError'` -> `AUTH_UNAVAILABLE`
- unknown error shape -> `AUTH_UNAVAILABLE`

Return structured auth results:
- invalid/expired token -> `{ user: null, errorCode: 'AUTH_INVALID', ... }`
- no user -> `{ user: null, errorCode: 'AUTH_NOT_FOUND', ... }`
- backend/client/unknown auth service failure -> `{ user: null, errorCode: 'AUTH_UNAVAILABLE', ... }`

In `withRateLimit()`:
- map `AUTH_UNAVAILABLE` and thrown auth service errors to `503 SERVICE_UNAVAILABLE`
- set a `Retry-After` header on this auth-unavailable `503`, fixed `5` seconds is acceptable
- emit a structured log event like `{ event: 'auth_backend_unavailable' }`
- do not log token, cookie, session, or other credential-bearing details in auth-outage events
- keep invalid/expired/no-user as `401 UNAUTHORIZED`
- do not add IP fallback for protected routes

Tests:
- `getUserFromRequest()` returns `AUTH_INVALID` for `{ status: 401 }` and `{ status: 403 }`.
- returns `AUTH_UNAVAILABLE` for `{ status: 503 }`, `{ status: 429 }`, and `{ name: 'AuthRetryableFetchError' }`.
- `withRateLimit()` returns `503`, not `401`, when `getUserFromRequest()` returns `AUTH_UNAVAILABLE`.
- `withRateLimit()` returns `503` when `getUserFromRequest()` throws.
- auth-unavailable `503` includes `Retry-After`.
- protected routes still do not call rate limiting or handler on auth failure.

1. Fix checkout idempotency

Problem:
Checkout idempotency currently includes client-provided `checkoutAttemptNonce`, allowing parallel requests with different nonces to create multiple Stripe Checkout Sessions before local subscription state exists.

Immediate fix:
Remove client-controlled entropy from the Stripe idempotency key.

Use a server-owned UTC hour bucket key:
`billing_checkout_${userHash.slice(0, 24)}_${plan}_${hourBucketUtc}`

Example:
`const hourBucketUtc = Math.floor(Date.now() / (60 * 60 * 1000));`

Update:
- `src/pages/api/billing/checkout.js`
- `src/shared/validations/billingSchema.js`
- `src/pages/billing/index.js`
- `src/client/lib/billingPageActions.js` if the nonce helper becomes unused
- tests

Schema choice:
Because client and server are shipped together in this repo, prefer changing the checkout body to strict `{ plan }` and removing `checkoutAttemptNonce` from the client. Do not half-do this. If you keep accepting the old field for compatibility, explicitly ignore it and document why.
Update the client, shared schema, route, and tests together. Leaving the old nonce accepted but ignored is acceptable only if explicitly documented for compatibility, but the better implementation for this repo is strict `{ plan }`.

Current pending-checkout UX handling:
The hour-bucket replay approach was an intermediate fix and has been superseded by `billing_checkout_sessions` pending-session dedupe. Do not reintroduce hour-bucket-only Stripe idempotency. Current checkout handling should claim or reuse one active pending row per `user_id + plan`, persist the Stripe Checkout Session URL and expiry, and scope finalize/fail writes to the authenticated owner.

Recommended client recovery:
- If the pending Checkout Session is expired, canceled, missing locally, or no longer reusable, show a friendly "session expired" modal or inline message with a primary "Retry checkout" action.
- On retry, clear local checkout-in-progress state, pending checkout cookies/storage, and any cached Checkout URL before making a new checkout request.
- Before reusing a locally minted Checkout URL, re-fetch active local subscription status so entitled users are not sent back through checkout.
- If the re-fetch shows an active subscription, route the user back to billing/success state instead of reopening Stripe Checkout.

Suggested monitoring:
- `pending-checkout-reuse-rate`
- `pending-checkout-expired-retry-success`
- `pending-checkout-finalize-failure-rate`
- `pending-checkout-owner-scope-miss`

Tests:
- parallel duplicate submits for the same user and plan converge through one active `billing_checkout_sessions` row and return one persisted Stripe Checkout URL.
- different users claim separate pending checkout rows and keep user-specific Stripe idempotency material.
- stale `creating` rows are released and expired `open` rows are marked terminal before a new claim is minted.
- checkout route still validates the plan, uses the allowlisted price id, and scopes pending-session finalize/fail writes by owner.

1. Fix completed checkout that remains non-entitled

Problem:
After a completed checkout and authoritative reconcile, the route can still return `free` if local state remains non-entitled. That hides allowlist/configuration/sync integrity failures.

Fix:
In `src/pages/api/billing/checkout-status.js`, track whether:
- the Checkout Session was `complete`
- ownership passed
- a usable subscription id existed
- authoritative reconcile was attempted

After the second strict local read, if reconcile was attempted and refreshed local status is still not entitled, return:
`sendSuccess(res, 200, { state: 'error' }, ...)`

Keep `mapCheckoutStatus()` simple unless you find a cleaner existing pattern. This is route-specific integrity logic.

Tests:
- completed session + reconcile processed + refreshed `entitled: false` returns `error`.
- completed session + refreshed `entitled: true` returns `active`.
- open session + non-entitled still returns `pending`.
- missing subscription id still returns terminal `error`.

1. Update docs/stripe-next-phase-plan.md

Update the plan so future agents do not reintroduce the old behavior.

Make these documentation changes:
- In Chunk 4 checkout route contract, change the checkout request body to strict `{ plan }` if that is what you implemented.
- In Chunk 4 checkout idempotency section, explicitly state that idempotency entropy must be server-owned and must not come from request body/client nonce.
- Document that hour-bucket idempotency was superseded by `billing_checkout_sessions`; future changes should preserve pending-session dedupe and owner-scoped finalize/fail writes.
- In Chunk 5 “Current-branch gaps,” update webhook verifier decoupling to reference the new runtime split. It should say webhook verification depends only on secret key, derived mode, and active webhook secret.
- Replace the current `webhookSignature.test.js` / `NEXT_PUBLIC_APP_URL` drift note with the new expected contract: webhook signature tests should prove checkout-only config is not required.
- The plan must remove the old idea that `webhookSignature.test.js` should seed `NEXT_PUBLIC_APP_URL`; that is the opposite of the new runtime split.
- The corrected expected contract is: webhook signature verification works with Stripe secret/webhook-secret config only and does not require app URL or price env vars.
- In the raw-body cap section, mention cached `req.rawBody` Buffers as well as streamed request bodies and custom `maxBodyBytes`.
- Add a current-branch gap or resolved design note for duplicate checkout idempotency.
- Keep the Chunk 5 route plan focused on webhook route implementation. Do not imply this task implemented the public webhook route.

1. Update docs/feature-memory.md

Add a short entry describing:
- Stripe runtime decoupling
- webhook body-cap enforcement
- auth outage status mapping
- checkout idempotency hardening
- checkout-status terminal error behavior
- plan doc update

Run focused tests:

```powershell
npm test -- --runInBand src/server/lib/__tests__/stripe.test.js src/server/lib/__tests__/webhookSignature.test.js src/server/lib/__tests__/readRawBody.test.js src/server/middleware/__tests__/withWebhookAuth.test.js src/server/middleware/__tests__/withRateLimit.test.js src/server/api/__tests__/billing/checkout.test.js src/server/api/__tests__/billing/checkout-status.test.js src/server/lib/__tests__/billingService.test.js
```
