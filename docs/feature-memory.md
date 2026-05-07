# Feature Memory

Use this file as a quick-running log of implemented changes.

## What to record
- Briefly note the feature, enhancement, or addition that was completed.
- Keep entries short and easy to scan.
- Add the date so the history is easy to follow.

## Entry Template
- `YYYY-MM-DD` - `Feature or change name`: short note on what was added or updated.

## Entries
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
