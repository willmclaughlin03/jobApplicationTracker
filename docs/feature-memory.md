# Feature Memory

Use this file as a quick-running log of implemented changes.

## What to record
- Briefly note the feature, enhancement, or addition that was completed.
- Keep entries short and easy to scan.
- Add the date so the history is easy to follow.

## Entry Template
- `YYYY-MM-DD` - `Feature or change name`: short note on what was added or updated.

## Entries

### Week of 2026-06-15

- `2026-06-20` - `Chunk 9 review follow-ups`: Added billing-page terminal-Free archive notice coverage and guarded full job fetches against stale state updates.
- `2026-06-20` - `Storage warning freshness hardening`: Refreshed dashboard storage summaries after add/delete mutations, guarded out-of-order refreshes, and surfaced billing-page storage-status failures without showing confirmed downgrade copy.
- `2026-06-20` - `Storage downgrade warning and archive UI`: Added storageSummary-powered dashboard warnings, locked archive teaser preview/export entry points, billing-page downgrade copy, active-only analytics labeling, and locked-plan error normalization.
- `2026-06-20` - `Storage export invalid-user error`: Replaced the export service's generic invalid-user error with a stable custom error carrying code and status metadata.
- `2026-06-20` - `Storage export CSV payload guard`: Made the storage export route fail closed when the export service returns missing or non-string CSV payloads.
- `2026-06-20` - `Storage export query validation`: Replaced manual export query-key checks with a strict empty Zod schema so unsupported query parameters are rejected through the standard validation pattern.
- `2026-06-18` - `Job CSV export`: Added an authenticated storage export endpoint with owner-scoped active-plus-locked CSV output, dedicated export rate limits, no-store download headers, and focused route/service coverage.
- `2026-06-18` - `Job CSV export keyset pagination`: Replaced offset-based export paging with a stable `(created_at, id)` keyset cursor so large CSV exports avoid duplicate or skipped rows near page boundaries.
- `2026-06-18` - `Premium restore ordering test fixture`: Renamed the restore-ordering active baseline fixture so restored-row assertions only inspect rows unlocked by the Premium restore RPC.
- `2026-06-18` - `Storage transition malformed-envelope guard`: Made shared storage-transition repair fail closed when downgrade or restore dependencies return missing success data, with focused service coverage.
- `2026-06-18` - `Storage transition service rejection guard`: Normalized downgrade and Premium restore dependency rejections into fail-closed storage-transition envelopes with focused service coverage.
- `2026-06-18` - `Single-job repair rejection guard`: Kept single-job detail/update storage-transition repair fail-closed when reconciliation rejects and covered the rejected-promise path.
- `2026-06-18` - `Jobs collection repair rejection guard`: Kept jobs list/create storage-transition repair fail-closed when reconciliation rejects and covered the rejected-promise path.
- `2026-06-18` - `Storage status repair rejection guard`: Kept storage-status transition repair fail-closed when reconciliation rejects and covered the rejected-promise path.
- `2026-06-18` - `Premium storage restore hardening`: Tightened Chunk 7 restore with DB-enforced Premium price allowlisting, stale Premium status refresh after canonical mismatch, and focused regressions for non-allowlisted prices and restore races.
- `2026-06-15` - `Premium storage restore`: Added Premium re-entitlement restore for locked overflow jobs with a service-role RPC, shared storage-transition repair wiring, over-cap monitoring, and focused regression coverage.
- `2026-06-15` - `Storage summary string status normalization`: Preserved raw string storage status overrides when building count-only storage summaries.
- `2026-06-15` - `Subscription delete webhook repair coverage`: Added dispatcher coverage proving processed subscription delete events run downgrade storage repair before receipt recording.
- `2026-06-15` - `Overflow locking CAS timestamp retry`: Replaced the fixed E8 integration-test timestamp delay with a bounded retry that waits for the billing subscription snapshot timestamp to advance.
- `2026-06-15` - `Overflow locking integration cleanup checks`: Made overflow-locking integration cleanup fail on Supabase table or auth-user deletion errors.
- `2026-06-15` - `Jobs list storage repair snapshot guard`: Made the jobs list route fail closed when lazy downgrade repair omits the typed storage status snapshot.
- `2026-06-15` - `Stripe webhook storage repair route coverage`: Added public webhook route tests for post-dispatch storage repair success, stale skip, and repair failure handling.

### Week of 2026-06-08

- `2026-06-14` - `Premium downgrade concurrency hardening`: Strengthened unpublished migration `018` with canonical billing revalidation, guarded authoritative reconciliation, shared billing/storage locks, create-versus-lock serialization, direct job-route lazy repair, and resolved-status reuse.
- `2026-06-13` - `Premium downgrade overflow locking`: Added terminal-Free-only downgrade repair with idempotent overflow locking, webhook/lazy request wiring, and focused regression coverage.
- `2026-06-11` - `Premium downgrade locked job API enforcement`: Added locked archive teaser listings, locked detail/update 423 responses, safe locked single-delete responses, and salary-prefetch protection for plan-locked rows.
- `2026-06-11` - `Atomic create quota SQL-safe test setup`: Replaced dynamic integration-test SQL literals with Supabase table API seeding and counts.
- `2026-06-11` - `Unmapped create error status handling`: Changed unmapped job-create failures to preserve service status or surface as 500 while keeping public add-failed copy.
- `2026-06-11` - `Billing review create error coverage`: Added API route coverage for billing-state review create failures returning the public 409 response.

### Week of 2026-06-01

- `2026-06-10` - `Premium downgrade atomic create quota`: Added a service-role atomic job-create RPC, wired POST job creation to typed storage status, and covered active/retained quota race behavior.
- `2026-06-10` - `Premium downgrade storage summaries`: Added count-only active, locked, retained, and projected-overflow helpers plus `storageSummary` API metadata and a metadata-only storage status route.
- `2026-06-08` - `Job create server-field sanitization`: Stripped server-controlled job fields from create payloads before admin inserts and covered the guard with focused job service tests.
- `2026-06-08` - `Premium downgrade storage schema boundary`: Added the jobs storage-state migration, CHECK constraints, storage-state indexes, service-owned jobs access boundary, and direct-access integration evidence for locked overflow rows.
- `2026-06-07` - `Premium sync-pending create retry contract`: Aligned sync-pending storage create-flow retryability with the top-level storage retryability contract.
- `2026-06-07` - `Premium downgrade storage status contract`: Added the canonical storage-policy status vocabulary, strict billing-aware storage resolver, lock eligibility contract, and create-flow classification tests for paid-to-free degradation.
- `2026-06-01` - `Redis rate-limit timeout fail-closed fix`: Disabled Upstash Ratelimit's fail-open timeout, added a Redis HTTP request timeout, and covered timeout-shaped limiter responses with focused tests.
  - impact: Slow Redis rate-limit checks now follow the app's intended fail-closed path instead of allowing requests after the library timeout.

### Week of 2026-05-25

- `2026-05-31` - `Billing migration fingerprint detector`: Updated the billing migration integration harness to detect the customer email fingerprint CHECK by definition so Postgres identifier truncation does not cause false migration replays.
  - impact: Focused billing migration validation can run against already-applied Supabase schemas where Postgres truncated the long constraint name.
- `2026-05-31` - `Stripe event RPC ambiguity fix`: Added a forward billing migration that repairs the event-driven subscription upsert RPC variable/column name collision.
  - impact: Real Stripe webhook reconciliation can stamp `last_stripe_event_created` instead of failing receipts with ambiguous-column database errors.
- `2026-05-28` - `Stripe premium plan migration`: Added a forward billing migration that updates existing pending-checkout database constraints and RPC plan guards from `resume_tailor_monthly` to `premium_monthly`.
  - impact: Checkout claims now stay aligned with the app-level premium plan contract after the plan rename is deployed.
- `2026-05-27` - `Stripe premium plan naming`: Renamed the Stripe billing plan/env contract from resume-tailor-specific names to generic premium monthly access.
  - impact: Billing setup no longer depends on an unlaunched resume-tailor product surface while preserving the same premium subscription flow.
- `2026-05-27` - `Stripe local integration harness hardening`: Added paginated Stripe Event lookup, bounded webhook-state polling, temporary fixture receipt cleanup, and a remote Supabase fixture-write opt-in gate.
  - impact: Local billing drills are less flaky on delayed webhook delivery and avoid leaving persistent fixture receipts in shared databases.
- `2026-05-27` - `Stripe local integration harness`: Added a safety-gated `billing:test-stripe-local` command for process-env preflight checks, signed webhook fixtures, and post-Checkout DB/receipt assertions.
  - impact: Operators can now execute the local Stripe integration plan without reading `.env` files or risking live-mode charges.
- `2026-05-27` - `Stripe local integration runbook`: Added the local Stripe CLI integration runbook with env-shape preflight, auth/CSRF harnessing, Dahlia payload checks, webhook replay/failure drills, and staging deployment gates.
  - impact: Billing rollout evidence now has concrete operator checks for real Stripe payloads, local entitlement rows, and deployment-only webhook risks.
- `2026-05-27` - `Stripe subscription item period sync`: Read subscription period end from Stripe Subscription Items before falling back to the legacy parent Subscription field.
  - impact: Dahlia-shaped subscription syncs keep `billing_subscriptions.current_period_end` populated for renewal sweeps and monitoring.
- `2026-05-27` - `Stripe API version alignment`: Updated the pinned Stripe API version to `2026-04-22.dahlia` to match the currently available webhook endpoint version in Stripe Workbench.
  - impact: App-created Stripe requests and Dashboard webhook event versioning can be validated against the same Dahlia API release.
- `2026-05-26` - `Stripe Chunk 7 PR cleanup`: Merged Chunk 7 operational readiness onto latest main and carried forward the reviewed fix layer.
  - impact: The readiness PR now centers on Chunk 7 and follow-up fixes instead of an outdated broad diff.
- `2026-05-26` - `Stripe runtime error status metadata`: Added dedicated Stripe runtime config error classes with stable HTTP status codes.
  - impact: Stripe config and webhook verifier failures are easier for centralized handlers to map consistently.
- `2026-05-26` - `Raw body error status mapping`: Added a dedicated raw-body error type with stable HTTP status metadata.
  - impact: Webhook raw-body failures carry predictable status codes for downstream error handling.
- `2026-05-26` - `Webhook signature test helper docs`: Documented Stripe env, payload, request, and module-loading helpers.
  - impact: Webhook signature tests are easier to audit without changing runtime behavior.
- `2026-05-26` - `Stripe test helper docs`: Documented Stripe env setup and module-loading helpers used by config tests.
  - impact: Stripe config tests are easier to audit without changing runtime behavior.
- `2026-05-26` - `Billing service test helper docs`: Documented Supabase client/query mocks and expected billing hash helpers.
  - impact: The billing service unit-test harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Billing migration cleanup failure surfacing`: Made billing migration test cleanup throw when billing row deletes return errors or unexpected statuses.
  - impact: Integration runs stop on cleanup failures instead of silently carrying leaked billing state into later tests.
- `2026-05-26` - `Billing migration test helper docs`: Documented integration-test helper functions for RPC normalization, auth sign-in, migration setup, SQL execution, and billing row cleanup.
  - impact: The billing migration integration harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Billing status test helper docs`: Documented request and response mock helpers used by billing status route tests.
  - impact: The billing status test harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Portal route test helper docs`: Documented request and response mock helpers used by portal route tests.
  - impact: The portal test harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Checkout route test helper docs`: Documented request and response mock helpers used by Checkout route tests.
  - impact: The Checkout test harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Checkout-status test helper docs`: Documented request and response mock helpers used by checkout-status route tests.
  - impact: The checkout-status test harness is easier to audit without changing runtime behavior.
- `2026-05-26` - `Billing success page function docs`: Documented the success-page session id helper, outcome copy helper, and page component dependencies, params, returns, and side effects.
  - impact: Billing success redirect behavior is easier to audit without changing runtime behavior.

### Week of 2026-05-18

- `2026-05-24` - `Billing status rejection handling`: Handled rejected billing status loads and covered the outage UI fallback.
  - impact: Billing no longer stays stuck loading when the status request rejects.
- `2026-05-24` - `Billing page function docs`: Documented the billing page date formatter and main page component dependencies, params, returns, and side effects.
  - impact: Billing page behavior and redirect connections are easier to audit without changing runtime behavior.
- `2026-05-24` - `Billing cancel page docs`: Documented the cancel redirect page's purpose, routing dependencies, params, and side-effect-free return.
  - impact: Billing cancel redirect behavior is easier to audit without changing runtime behavior.
- `2026-05-24` - `Storage-limit API message sanitization`: Stopped returning service-layer storage-limit details from the jobs create endpoint.
  - impact: Storage-limit responses now use the shared public-safe message.
- `2026-05-24` - `Portal route handler docs`: Documented the billing portal API handler's purpose, authenticated inputs, and Stripe response side effects.
  - impact: The portal route is easier to compare with checkout handler safety docs.
- `2026-05-24` - `Checkout route handler docs`: Documented the billing Checkout API handler's purpose, inputs, and Stripe/local state side effects.
  - impact: The checkout route is easier to review against billing safety expectations without changing behavior.
- `2026-05-24` - `Billing success helper docs`: Added focused comments for checkout-status poll interpretation, exhaustion handling, and poll-delay calculation.
  - impact: The billing success polling helpers are easier to audit without changing runtime behavior.
- `2026-05-24` - `Billing ready-null summary fallback`: Treated missing billing data in a ready page state as unavailable instead of no subscription.
  - impact: Billing copy now distinguishes absent local billing data from a confirmed free account.
- `2026-05-24` - `Billing redirect URL allowlist`: Validated billing checkout and portal redirect URLs on the client before navigation.
  - impact: Billing page redirects now reject unexpected schemes or hosts before handing control to the browser.
- `2026-05-24` - `Checkout drain output allowlist`: Limited drain CLI row output to explicit safe fields while continuing to redact Stripe Checkout Session ids.
  - impact: Operator drain logs are less likely to expose future sensitive service fields.
- `2026-05-24` - `Rate-limit check extraction`: Moved tier resolution, admin-route probing fallback, and limiter failure handling into a focused middleware helper.
  - impact: Rate-limit behavior stays easier to audit while preserving fail-closed handling.
- `2026-05-24` - `Stripe Chunk 7 operator readiness`: Added the Checkout drain operator command, Chunk 7 billing monitoring signals, route-boundary webhook coverage, and harder disabled-import coverage.
  - impact: Paid rollout now has a runnable emergency drain path and stronger evidence that new webhook events and Checkout halt boundaries stay wired correctly.
- `2026-05-22` - `Checkout halt and Jest env isolation`: Moved Checkout creation config behind the enabled path and removed global dotenv loading from Jest setup.
  - impact: Emergency Checkout disables can return without loading Checkout config modules, and focused tests no longer silently read local `.env` secrets.
- `2026-05-22` - `Stripe Chunk 7 operational hardening`: Implemented the Checkout emergency halt, lazy Stripe config boundaries, card-only Checkout, pinned portal configuration, open Checkout Session drain support, expired/action-required webhook handling, and admin billing delete preflight.
  - impact: Paid rollout now has stronger emergency controls and deletion safeguards while keeping tax collection behind the required dated owner decision before live Checkout.
- `2026-05-22` - `Stripe Chunk 7 emergency and refund policy`: Added already-minted Checkout Session expiration, payment-wins race handling, tax/payment-action gates, and cancel-at-period-end no-automatic-refund launch policy to the rollout plan.
  - impact: Paid rollout now has clearer incident controls and a simpler customer cancellation policy before public Checkout is enabled.
- `2026-05-22` - `Stripe Chunk 7 gap research brief`: Added a handoff brief for deeper review of open Checkout URL expiration, tax/invoice compliance, payment-action recovery, and refund policy gaps.
  - impact: The next billing reviewer has a sourced map of the remaining rollout questions before Chunk 7 is edited again.
- `2026-05-22` - `Stripe Chunk 7 best-option rollout plan`: Tightened Chunk 7 around config-independent Checkout halt behavior, card-only Checkout, pinned portal configuration, scheduled drift audit, rollback runbooks, and live logging enforcement.
  - impact: Paid rollout now points implementers toward the safest launch path instead of treating weaker operational checks as equivalent substitutes.
- `2026-05-22` - `Stripe Chunk 7 review hardening plan`: Added config-independent Checkout halt, portal independence, complete billing deletion preflight, payment-method drift control, and portal configuration drift control to the rollout gate.
  - impact: Chunk 7 now blocks paid rollout on the verified code and Stripe-configuration gaps that could otherwise cause partial deletion, broken rollback, or entitlement drift.
- `2026-05-21` - `Stripe Chunk 7 blocker implementation plan`: Added route-level Checkout halt, admin deletion preflight, delayed-payment policy, webhook mode mapping, and portal config pinning tasks to the Chunk 7 rollout gate.
  - impact: Paid rollout now names the concrete implementation and evidence needed to close verified billing readiness gaps.
- `2026-05-20` - `Stripe webhook timestamp-string normalization`: Treated digit-only Stripe event `created` strings like epoch-second numbers in mismatch logs.
  - impact: Receipt envelope mismatch logs now show comparable ISO timestamps when Stripe-created values arrive as numeric strings.
- `2026-05-20` - `Stripe delete webhook payload validation`: Rejected non-object subscription delete payloads before the billing service receives them.
  - impact: Malformed delete webhooks now fail closed without passing string payloads into subscription terminalization.
- `2026-05-20` - `Stripe webhook dispatcher audit fixes`: Normalized malformed delete events onto the webhook malformed-event code, added future-timestamp rejection logging, made receipt mismatch timestamps comparable, and covered subscription-delete dispatcher paths.
  - impact: Webhook failures now produce clearer operational signals while preserving fail-closed retry behavior.
- `2026-05-20` - `Stripe Chunk 7 audit hardening`: Added kill-switch, rollback, backup/rebuild, portal, trial, dispute, downgrade, alert escalation, and live cutover gates to the Stripe rollout plan.
  - impact: Paid billing launch now requires operator-ready recovery procedures and product-policy decisions before Checkout can be exposed.
- `2026-05-20` - `Stripe Chunk 7 rollout gate`: Reworked Chunk 7 into a production readiness runbook with Stripe-side audits, explicit Dashboard webhook setup, local data checks, monitoring gates, staging drills, and residual-risk documentation.
  - impact: Paid rollout now has concrete go/no-go evidence requirements instead of a loose operational checklist.
- `2026-05-20` - `Billing receipt timestamp simplification`: Replaced a tautological receipt-merge `processed_at` CASE with a direct timestamp assignment.
  - impact: The billing receipt migration now expresses the validated state transition more clearly without changing runtime behavior.
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
