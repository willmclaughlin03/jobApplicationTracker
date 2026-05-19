# Feature Memory

Use this file as a quick-running log of implemented changes.

## What to record
- Briefly note the feature, enhancement, or addition that was completed.
- Keep entries short and easy to scan.
- Add the date so the history is easy to follow.

## Entry Template
- `YYYY-MM-DD` - `Feature or change name`: short note on what was added or updated.

## Entries

### Week of 2026-05-18

- `2026-05-19` - `Stripe Chunk 6 billing hardening follow-up`: Validated authenticated checkout emails, sanitized receipt envelope mismatch errors, and made billing migration integration coverage trackable.
  - impact: Checkout and webhook receipt integrity failures now fail closed earlier without exposing raw database mismatch details in logs.
- `2026-05-18` - `Stripe Chunk 6 webhook ingress`: Added the public billing webhook route, explicit event dispatcher, processing receipt claims, non-current subscription guards, checkout-session terminal cleanup, checkout email gating, and focused webhook coverage.
  - impact: Stripe billing events now have a verified public path into canonical local billing reconciliation without granting entitlement from webhook payload fragments.
- `2026-05-18` - `Stripe Chunk 6 processing and receipts plan`: Added light webhook `processing` receipt-state guidance, Stripe-managed receipt email expectations tied to OAuth account email, and rollout checks for stuck processing plus receipt delivery.
  - impact: The pending webhook plan now covers in-flight retry safety and smoother receipt UX without introducing custom email side effects.

### Week of 2026-05-11

- `2026-05-17` - `Pending checkout UX docs`: Reframed stale hour-bucket replay guidance around the current pending-session dedupe model and owner-scoped recovery metrics.
- `2026-05-17` - `Pending checkout owner-scoped writes`: Required user ids for pending checkout finalize/fail helpers and filtered writes by owner.
- `2026-05-17` - `Billing checkout plan allowlist`: Added migration-level plan allowlist enforcement for pending checkout sessions and RPC claims.
- `2026-05-17` - `Billing checkout session grants`: Granted service-role table and identity-sequence access for pending checkout session claims and admin updates.
- `2026-05-17` - `Patch command fence fix`: Closed the focused-test command block in `docs/patches.md` so the markdown renders correctly.
- `2026-05-17` - `Stripe test reset guard`: Added a `NODE_ENV=test` runtime guard and security documentation for the Stripe runtime test reset helper.
  - impact: Production code cannot accidentally clear memoized Stripe runtime state through the test-only helper.
- `2026-05-16` - `Stripe checkout terminal cleanup`: Marked completed/expired Checkout Sessions terminal in local pending-session state, tightened checkout expiry validation, extended duplicate-submit convergence, and documented the success-polling limitation for terminal cleanup.
- `2026-05-16` - `Stripe pending checkout dedupe`: Added service-role pending Checkout Session claims, checkout route reuse/failure handling, local checkout-status mint checks, focused tests, and migration `013_billing_checkout_sessions.sql`.
- `2026-05-16` - `Stripe next-phase chunk reorder`: Moved pending Checkout Session dedupe ahead of public webhook work, renumbered the rollout chunks, and added production-cutover blockers for checkout dedupe plus Stripe customer mapping consistency.
- `2026-05-12` - `Stripe Chunk 7 pending-checkout plan`: Added a dedicated Chunk 7 to `docs/stripe-next-phase-plan.md` for Supabase-backed pending Checkout Session dedupe and replaced the stale nonce-preservation guidance.
- `2026-05-11` - `Stripe runtime schema validation`: Centralized Stripe secret-key env validation behind a Zod schema shared by runtime config resolution and webhook env-snapshot mode selection.
- `2026-05-11` - `Stripe runtime env-cache isolation`: Limited Stripe runtime config cache writes to `process.env` resolutions so custom env snapshots validate without poisoning global runtime state.
- `2026-05-11` - `Auth-invalid log severity`: Lowered expected 401/403 token validation failures from error logs to warnings while preserving sanitized auth metadata and returned auth payloads.
- `2026-05-11` - `Webhook env snapshot mode selection`: Updated webhook secret lookup to choose test/live secrets from the provided Stripe env snapshot before falling back to cached runtime mode.
- `2026-05-11` - `Checkout nonce idempotency restore`: Switched checkout idempotency back to validated per-attempt nonces combined with the server-side user hash and plan so stale hourly Stripe Checkout Sessions are not replayed.
- `2026-05-11` - `Webhook verifier config status fix`: Mapped Stripe runtime config failures from webhook verification to `503 SERVICE_UNAVAILABLE` and added middleware coverage for invalid Stripe runtime configuration.
- `2026-05-11` - `Stripe billing foundation hardening`: Split Stripe runtime from checkout-only config, enforced webhook raw-body caps for cached and streamed bodies, mapped auth backend outages to 503, initially replaced client checkout nonces with server-owned hour-bucket idempotency; later restored nonce-backed checkout idempotency - see `2026-05-11 - Checkout nonce idempotency restore`, made completed non-entitled checkout reconciliation terminal, and updated the Stripe next-phase plan.

### Week of 2026-05-04

- `2026-05-10` - `Stage 5 webhook plan gap audit`: Expanded Chunk 5 of `docs/stripe-next-phase-plan.md` with verified current-branch webhook and billing-contract gaps, resolved the duplicate-receipt semantics contradiction in favor of preserving `processed`, and added concrete code references plus test expectations for the follow-up fixes.
- `2026-05-09` - `Stripe Stage 5 and Phase 6 plan rewrite`: Replaced the public-webhook chunk with the finalized thin-route plus dispatcher plan, clarified duplicate-receipt semantics and unexpected `CUSTOMER_NOT_FOUND` monitoring, and added explicit Phase 6 rollout context plus end-of-phase WAF hardening.
- `2026-05-09` - `Review guidance for automated findings`: Added repo-level review-quality and output-format guidance to `AGENTS.md` and `CLAUDE.md` so automated reviewers verify findings against current code, focus on concrete billing/auth/race-condition issues, and report actionable fixes.
- `2026-05-09` - `Billing success manual-refresh latch`: Added a refresh-pending guard on the success-page manual refresh button, documented the latch/reset behavior in the polling JSDoc, and covered duplicate-click suppression with focused page coverage.
- `2026-05-09` - `Billing success rejected-poll guard`: Wrapped the success-page checkout-status poll interpretation in a local fail-closed catch so rejected poll promises clear cooldown/timers, settle into a terminal error state, and stop the continuing polling UI; added focused page coverage.
- `2026-05-06` - `Billing success polling docs`: Documented the billing success-page polling effect and `runPoll()` state machine, including dependency start/stop rules, outcome transitions, backoff exhaustion, and timer/cancellation cleanup semantics.
- `2026-05-06` - `Stripe test NODE_ENV teardown fix`: Updated the Stripe test suite teardown to delete `process.env.NODE_ENV` when it was originally unset instead of restoring the literal `"undefined"` string.
- `2026-05-06` - `Billing action submit guards`: Added handler-side in-flight latching on the billing page so checkout and portal clicks optimistically mark themselves loading and ignore duplicate submissions before the UI re-renders, with focused page tests for repeated clicks.
- `2026-05-06` - `Billing page unauthorized recovery`: Updated the billing status load path to treat `401` responses as expired auth, trigger `signOut()` plus login redirect instead of a false service-outage state, and added focused billing-page coverage.
- `2026-05-06` - `Rate-limit IP validation tightening`: Replaced permissive regex-based public-route IP checks with strict `node:net` `isIP()` validation, kept the CloudFront header precedence and fail-closed behavior, and added focused malformed-header coverage.

### Week of 2026-04-27

- `2026-05-03` - `Billing polling, idempotency, and Stripe sync hardening`: Raised `billing_write` quotas to protect the success-page poll flow, replaced hour-bucket checkout idempotency with client nonces, tightened checkout-status retry and ownership handling, pinned explicit Stripe timeout/retry config, added best-effort Stripe email fingerprint dedupe plus migration, extended shared-client response metadata, and aligned billing-page/success-page helpers and focused tests with the new cooldown and redirect-loading behavior.
- `2026-05-03` - `Billing ownership assertion and portal-capability gating`: Added a service-layer expected-user assertion for authoritative Stripe subscription syncs, made checkout-status require positive completed-session customer confirmation before reconcile, exposed `hasPortalCustomer` from the billing status API, and aligned billing-page portal gating and focused tests with the backend contract.
- `2026-05-02` - `Billing checkout flow hardening`: Fixed billing-page error-state gating, treated success-page fetch failures as temporary unavailability, made checkout-status stop on terminal reconcile outcomes, added Stripe customer-consistency guards before reconcile, and hardened app URL building against off-origin inputs.
- `2026-05-02` - `Billing and middleware comment pass`: Added or improved repo-style function header comments across the main billing, Stripe config, rate-limit, webhook-auth, and user-tier helpers, with emphasis on canonical local billing state and fail-closed behavior.
- `2026-05-02` - `Function-comment requirement clarified`: Added a repo instruction requiring every newly written function to carry a short header comment in the existing codebase style, and documented the Stripe app-origin validator's deliberate no-subpath tradeoff inline.
- `2026-05-02` - `Chunk 4 authenticated billing routes and pages`: Added the billing request schemas, strict route-facing billing reads, Stripe app-origin validation, authenticated billing API routes, `/billing` plus success/cancel pages, the tested success-page polling helper, and a Billing entry in the profile dropdown.
- `2026-04-30` - `Chunk 4 billing plan contract rewrite`: Rewrote the authenticated billing-routes plan into a decision-by-decision implementation guide with code references, security reasoning, success-page polling rules, and route-facing strict-read requirements for future agents.
- `2026-04-30` - `Mapped-customer upsert race email sync`: Added the missing best-effort Stripe email sync on the post-upsert mapped-customer return path and covered it with a focused regression test.
- `2026-04-30` - `Stripe email sync helper docs`: Added repo-style JSDoc for the Stripe customer email sync helper, including flow context, side effects, parameter types, and return behavior.
- `2026-04-30` - `Stripe warning log sanitization`: Replaced the raw provider error object in the Stripe customer email-sync warning with a safe `{ name, code, message }` shape and tightened the related Jest coverage.
- `2026-04-30` - `Feature memory log created`: Added the shared quick-reference file for briefly tracking completed features and changes.
- `2026-04-30` - `Billing hardening scope narrowed`: Logged the targeted follow-up for stable Stripe customer creation, delete-event race removal, future-timestamp validation, and small billing cleanup work before branch edits.
- `2026-04-30` - `Billing hardening follow-up implemented`: Reworked Stripe customer creation to keep the idempotent `customers.create` body stable and move email sync into a separate best-effort `customers.update`, removed delete-event fallback merging so canceled snapshots come from the Stripe event itself, added a 5-minute future-timestamp guard across event-driven billing entry points, normalized stale write outcomes onto `BILLING_WRITE_OUTCOMES.STALE_IGNORED`, and added focused Jest coverage for email-sync retries, partial delete events, future timestamp rejection, and duplicate-log suppression.
