# Feature Memory

Use this file as a quick-running log of implemented changes.

## What to record
- Briefly note the feature, enhancement, or addition that was completed.
- Keep entries short and easy to scan.
- Add the date so the history is easy to follow.

## Entry Template
- `YYYY-MM-DD` - `Feature or change name`: short note on what was added or updated.

## Entries

### Week of 2026-07-19

- `2026-07-24` - `Migration-suite readiness diagnostics`: Gave each staging migration-suite auth-user cleanup a distinct A/B label while preserving names-only failure reporting and unchanged deletion behavior, made the canonical migration assertion compare the complete ordered remote catalog without a hardcoded version filter, and covered duplicate cleanup-label deduplication across returned and rejected failures.
- `2026-07-23` - `Trusted integration readiness hardening`: Added an offline wrong-project refusal proof, names-only all-attempted teardown, canonical schema/catalog assertions, workflow-correlated Redis evidence keys, and a restricted test-only SQL helper with its own pgTAP contract.
  - impact: Manual staging integration runs now fail closed before remote imports, expose cleanup failures without leaking identifiers, and keep the arbitrary-SQL helper outside the deployable migration chain.
- `2026-07-23` - `Fail-closed public default privileges`: Limited future public tables, sequences, and functions to administrative service roles and added a disposable-object pgTAP regression guard against client-role inheritance.
- `2026-07-23` - `Authoritative Supabase baseline publication`: Added the reviewed local Supabase configuration, authoritative pre-production baseline and reconciliation migrations, and the 71-assertion pgTAP final-state contract.
  - impact: The dedicated integration-test project can be provisioned from a version-controlled canonical migration chain before any test-only database helper is installed.
- `2026-07-22` - `Trusted integration default permissions`: Denied GitHub token permissions at the workflow level while preserving each job's explicit least-privilege override.
- `2026-07-22` - `Trusted staging integration workflow`: Added a manual, staging-ref-only GitHub Actions workflow with an Environment-secret preflight, exact Supabase target verification, deployment-credential fallback refusal, serialized infrastructure access, and child-process-only destructive test opt-in.
  - impact: Missing canonical names, a mismatched Supabase target, or configured deployment fallbacks now fail safely before Jest imports destructive suites or contacts remote test infrastructure.
- `2026-07-22` - `Empty Stripe plan-label normalization`: Moved final trimming after control-character replacement and whitespace collapsing so control-only unsupported plans render as `[empty]`, with focused regression coverage.
- `2026-07-22` - `Storage downgrade billing-link coverage`: Added focused regression coverage that keeps the scheduled-downgrade banner's Review billing CTA linked to `/billing`.
- `2026-07-22` - `Superseded CI run cancellation`: Grouped CI runs by workflow and pull-request or ref identity so newer runs cancel obsolete in-progress work without affecting other pull requests or refs.
- `2026-07-22` - `Secret-free pull-request CI`: Added the SHA-pinned `CI / unit-lint-build` GitHub Actions gate for pull requests and protected-branch pushes, with exact Node 22 dependency installs, a strict Next.js lint baseline, deterministic unit tests, and build-only non-secret placeholders.
  - impact: Changes targeting `staging` or `main` can be checked without repository secrets, GitHub Environments, integration infrastructure, deployment steps, or artifact uploads.

### Week of 2026-07-12

- `2026-07-21` - `Billing success unresolved-status retry`: Added the existing manual refresh action to the explicit unresolved checkout ERROR state while preserving its payment-status wait copy, with page-level regression coverage for retrying into an active state.
  - impact: Customers can recheck an unresolved payment status without performing a full browser reload.
- `2026-07-20` - `Billing payment-status outcome copy`: Reserved the patient payment-status message for explicit unresolved status while keeping missing session ids, rejected requests, and invalid responses on a distinct terminal-error path; removed the internal polling schedule from the customer-facing page and covered that explicit error status stops further polling.
  - impact: Customers waiting for payment status see appropriate wait copy, while failures that cannot recover through polling retain clear terminal guidance.
- `2026-07-19` - `Dashboard billing-entry initial-load skeleton`: Replaced the unresolved storage-summary Billing fallback with a non-interactive, fixed-size skeleton while preserving settled fail-closed Billing behavior and resolved labels during later refetches.
  - impact: New and Free users no longer see Billing flash before Upgrade, while Premium users avoid an incorrect optimistic Upgrade label.
- `2026-07-19` - `Premium restore RPC signature reconciliation`: Added forward migration `028` to replace the stale three-argument restore overload with the hardened price-allowlisted signature, reassert service-role-only execution, and reload PostgREST schema metadata; added final-state, idempotency, legacy-upgrade, zero-archive Premium, and allowlist integration contracts.
  - impact: Existing pre-production databases can converge on the same Premium restore boundary as fresh migration replays without falling back to the weaker historical RPC.
- `2026-07-19` - `Billing action handler documentation`: Documented Checkout and Portal loading guards, shared-hook hand-offs, successful redirects, and unauthorized sign-out recovery.
- `2026-07-19` - `Billing action status-only auth coverage`: Covered Checkout 401 failures without an `UNAUTHORIZED` response code to preserve sign-out, login redirect, and sanitized rendering behavior.
- `2026-07-19` - `Dashboard skeleton source references`: Updated the loading skeleton's header, toolbar, and footer cross-file references to the current Dashboard line ranges without changing layout.
- `2026-07-19` - `Dashboard Premium billing entry integration`: Replaced the dead-end Resume control with fail-closed Upgrade, Manage plan, or Billing actions and connected confirmed Free users to the canonical-status upgrade modal.
  - impact: Dashboard users now retain a safe Billing path for every storage state, while only confirmed Free presentation state can open the modal and Checkout remains owned by the shared billing flow.
- `2026-07-19` - `Billing-status rejection coverage`: Added explicit schema coverage for unknown entitlement values and unexpected response fields.
- `2026-07-19` - `Upgrade modal entitlement consistency`: Rejected billing snapshots where the entitlement flag and canonical entitlement disagree so malformed responses remain retryable instead of enabling Checkout.
- `2026-07-18` - `Upgrade modal billing-status validation`: Added complete canonical response parsing before Dashboard upgrade eligibility checks so malformed, incomplete, incorrectly typed, or unknown subscription snapshots fail closed into the retryable error state.
  - impact: Dashboard Checkout cannot be enabled from a structurally invalid local billing response while valid Free and subscribed snapshots retain their existing eligibility behavior.
- `2026-07-18` - `Dashboard Premium upgrade modal`: Added a reusable Premium Features card and an accessible upgrade modal that rechecks canonical billing status before delegating eligible Checkout requests to the shared billing-actions hook.
  - impact: Confirmed Free users can receive a safe upgrade entry point with stale-response protection, auth recovery, Retry-After feedback, and focus-safe idle or busy behavior without trusting dashboard state as billing authority.
- `2026-07-18` - `Billing response metadata sanitizer coverage`: Added malformed Retry-After and out-of-range HTTP status cases to preserve sanitized billing errors while rejecting invalid response metadata.
- `2026-07-17` - `Billing action lifecycle hardening`: Prevented completed Checkout and portal requests from navigating after their hook unmounts, preserved secure nonce fallback when `randomUUID()` is unusable, and expanded portal plus legacy Billing-page error regression coverage.
  - impact: Shared billing actions now ignore stale redirect handoffs without weakening server authorization, redirect allowlisting, duplicate-action latching, or secure entropy requirements.
- `2026-07-17` - `Shared billing action infrastructure`: Added secure Checkout nonce generation, sanitized structured Checkout and portal outcomes, a cross-action synchronous latch, and a Retry-After countdown that survives UI resets.
  - impact: The upgrade modal and Billing page can share one fail-closed client redirect flow without weakening the existing Stripe-host allowlist or trusting client state as billing authority.
- `2026-07-17` - `Dashboard Premium entry contracts`: Added a frozen Premium plan catalog with tier-derived storage benefit copy and an exhaustive fail-closed dashboard billing-entry mapper.
  - impact: Later modal and dashboard chunks can consume stable presentation contracts without treating client state as billing or entitlement authority.
- `2026-07-16` - `Protected staging promotion workflow`: Created `staging` from the current production commit, protected `staging` and `main` with active pull-request rulesets, and documented the normal promotion, hotfix, and break-glass paths.
- `2026-07-16` - `Supabase mismatch suite selection`: Skipped the CSRF and rate-limit integration suites when their configured URL does not match the isolated Supabase test project.
- `2026-07-16` - `Shared post-Checkout wait deadline`: Bounded sequential customer, subscription, checkout, Stripe event, and receipt polling to one configured webhook wait budget.
- `2026-07-16` - `Shared destructive-suite registration`: Centralized destructive integration readiness and Jest run-or-skip selection for the reviewed database suites.
- `2026-07-16` - `CSRF fallback validation coverage`: Covered rejection of an undersized deterministic integration-test CSRF fallback when no TEST_CSRF value is supplied.
- `2026-07-16` - `Profile integration project guard`: Required the destructive opt-in and isolated Supabase project validation before profile round-trip upserts or cleanup deletes can run.
- `2026-07-16` - `Shared Supabase module bootstrap values`: Centralized the fixed fake application URL and service-role key used to bootstrap rate-limit integration module imports.
- `2026-07-16` - `Full-pipeline rate-limit project gate`: Skipped the live Redis/Supabase suite unless its URL matches the configured isolated Supabase test project.
- `2026-07-16` - `Supabase server integration project gate`: Skipped the real-auth suite unless its URL matches the configured isolated Supabase test project, before creating an admin client.
- `2026-07-16` - `Rate-limit integration project guard`: Required the configured Supabase test-project reference to match before creating or deleting the suite's disposable user.
- `2026-07-16` - `Shared integration CSRF fallback`: Centralized the deterministic test-only CSRF fallback in the integration environment helper for reuse across CSRF and rate-limit suites.
- `2026-07-16` - `Stripe event scan throttling`: Reduced full lookback pagination frequency while keeping each retry fresh enough to discover newly arrived events.
- `2026-07-16` - `Stripe local request timeouts`: Bounded local app health and signed webhook fixture requests so stalled endpoints fail with timeout diagnostics.
- `2026-07-16` - `CSRF integration project guard`: Required the configured Supabase test-project reference to match before creating or deleting the integration test user.
- `2026-07-14` - `Canonical integration-test environment contract`: Moved live Supabase integration clients to test-only credential names, retained destructive project guards, isolated TEST_CSRF mapping, and made direct Redis keys unique, expiring, and exactly cleaned up.
  - impact: Secret-free integration discovery skips safely, while trusted test jobs can no longer inherit deployed Supabase or CSRF credentials.
- `2026-07-13` - `Reconstructed Phase 0 migration history`: Added catalog-derived functional equivalents of root migrations 001-004 for user profiles, tailor cache, abuse counters, and daily spend; the timestamped Supabase baseline remains the active deployable chain.
  - impact: The four Phase 0 historical references are explicit and reviewable, while independent root-chain replay still requires a separately approved reconstruction of the manually created jobs base.

### Week of 2026-07-05
- `2026-07-13` - `Jest ignore-pattern preservation`: Kept the configured generated-worktree exclusions active in unit and CI scripts while adding the integration-test exclusion, and corrected literal-dot regex escaping.
- `2026-07-12` - `Deterministic CI test harness`: Restricted Jest discovery to the active `src` tree, split unit/CI/integration commands, listed guarded integration files before execution, added a names-only build environment preflight, and made missing infrastructure skip safely before fail-fast imports.
  - impact: Secret-free PR install, unit CI, and build completed locally in about 82 seconds against an under-five-minute clean-runner target; live integration credentials remain isolated for the later trusted workflow.
- `2026-07-12` - `Page test route isolation`: Moved all page and API-route Jest files into `src/__tests__/pages` and kept route-safety scanning pointed at production `src/pages/api`.
  - impact: Jest retains page coverage while production builds no longer compile or expose test files as routes.
- `2026-07-12` - `Health-check timeout cleanup`: Cleared losing Redis and Supabase health-check timers after early settlement and added focused coverage for successful, failed, and real timeout paths.
- `2026-07-12` - `Staging CI/CD baseline`: Established a clean `origin/main` worktree, standardized local and Amplify builds on rolling Node 22 with visible runtime versions, inventoried branches/worktrees without deletion, and removed an obsolete DOMPurify 3.3.1 patch after 3.3.3 incorporated the security guard upstream.
- `2026-07-12` - `Complete-list export assertion diagnostics`: Made Suite K verify export success and a string CSV payload before parsing exported companies so failures retain their original assertion context.
- `2026-07-12` - `Server-capped job-list pagination`: Continued complete-list keyset fetching after non-empty pages shorter than the requested transport size, stopping only on an empty page while preserving the absolute retained-job limit.

### Week of 2026-07-05

- `2026-07-11` - `Complete-list export identity coverage`: Strengthened Suite K to verify all 1001 expected CSV company identities, explicit overflow-row presence, and uniqueness alongside the export row count.
- `2026-07-11` - `Suite K resilient teardown`: Isolated fixture job and auth deletion attempts across all users and deferred aggregated cleanup errors until every teardown operation completes.
- `2026-07-11` - `Suite K lifecycle documentation`: Documented destructive integration setup dependencies, fixture auth/database effects, registered cleanup state, and teardown behavior.
- `2026-07-11` - `Complete-list integration preflight`: Made destructive Suite K runs fail immediately when required Supabase credentials are absent while retaining expected-project validation.
- `2026-07-11` - `Partial job-list page termination`: Stopped complete job-list pagination after partial transport pages while preserving the retained-limit overflow confirmation fetch.
- `2026-07-11` - `Transport-decoupled 1000-job storage limit`: Set Premium and retained storage to 1000 jobs, derived the 700-row locked bulk-delete bound, and added complete keyset dashboard/export reads with fail-closed payload and cursor validation.
  - impact: Dashboard and CSV completeness no longer depend on the PostgREST response maximum, and malformed or over-limit list reads cannot appear as successful partial data.

- `2026-07-10` - `Equal-time webhook recovery monitoring`: Locked the target-change warning contract and added an alertable structured signal whenever Stripe retries an existing failed webhook receipt.
- `2026-07-10` - `Deterministic same-second Stripe event handling`: Added locked canonical equality decisions, sticky terminal snapshots, fail-closed equal-time cross-subscription handling, strict guarded conflict reconciliation, and retryable webhook receipts for unresolved ties.
  - impact: Delayed same-second Stripe events can no longer restore Premium or replace a terminal subscription from arrival order alone, while safe no-op deliveries avoid subscription version and timestamp churn.
- `2026-07-10` - `Authoritative sync purpose validation`: Rejected empty and whitespace-only authoritative billing sync purposes and added integration coverage for both inputs.
- `2026-07-10` - `Snapshot-guarded authoritative Stripe sync`: Added a database-owned subscription version, mandatory exact-existing/exact-absent authoritative guards, purpose-enforced Checkout replacement rules, strict caller snapshots, and a single fresh same-subscription retry after conflicts.
  - impact: Stale Stripe reads can no longer overwrite a newer local subscription snapshot, timestamp collisions no longer weaken the CAS token, and failed billing reads cannot be mistaken for confirmed row absence.
- `2026-07-09` - `Verified security scan patch plan`: Validated ten billing, auth, rate-limit, admin-deletion, UUID, and request-body findings against the current tree and converted them into dependency-ordered implementation chunks for separate agents.
  - impact: Security remediation now has explicit migration ownership, concurrency guardrails, corrected finding scope, and focused verification requirements before production rollout.
- `2026-07-09` - `Status page factory`: Centralized custom status-page rendering and direct-response status setters for branded error pages.
- `2026-07-09` - `Framework error logging`: Logged uncaught Next.js page errors on the server while preserving safe error-page props and client rendering.
- `2026-07-09` - `Shared error status codes`: Centralized branded error page status codes for middleware public-route access and ErrorPage content lookup, with focused coverage.
- `2026-07-09` - `Custom error pages`: Added branded, public-safe error pages for 403, 404, 429, 500, 502, 503, and 504 with shared recovery actions and middleware access for direct error routes.
- `2026-07-09` - `Retry-After additive jitter`: Kept shared API Retry-After retries from undercutting server cooldown guidance while preserving jitter for client-generated backoff.
- `2026-07-09` - `Collection GET parallel follow-up`: Restored `GET /api` storage-summary and job-list reads to start concurrently after storage repair while preserving summary-error precedence and `storageStatusResult` policy input.
- `2026-07-08` - `Mutation create response storage summaries`: Derived POST storage summaries from atomic create RPC count hints so successful creates can skip a follow-up storage-status read when safe while preserving id-only DELETE responses from current main.
- `2026-07-08` - `Collection GET parallelization`: Ran storage summary counts and job list reads concurrently after storage repair while keeping fresh policy status separate from response metadata.
- `2026-07-08` - `Latency duration observability`: Added sampled structured API request-duration logging through the request-scoped logger with middleware coverage for success, rate-limit failures, skipped limits, 5xx, and slow requests.
- `2026-07-08` - `Repo-local Codex PR workflow`: Documented the repo-local `.tmp/worktrees` workflow, linked-worktree Jest command, and remaining Git metadata approval expectation to reduce Windows sandbox friction when pushing review branches.
- `2026-07-08` - `Client Retry-After jitter`: Applied bounded jitter to capped Retry-After retry delays so shared API clients avoid synchronized retries while preserving the server-provided base.
- `2026-07-08` - `Client retry backoff`: Made shared API retries honor Retry-After with capped delays and jittered backoff, with fake-timer retry coverage.
- `2026-07-08` - `Unpaginated job list count simplification`: Replaced exact counts on unpaginated job list reads with limit-plus-one truncation detection while preserving exact counts for paginated reads.
- `2026-07-08` - `Job list truncation query count`: Based unpaginated list truncation on the exact count from the same filtered jobs query so status-filtered and locked-archive reads do not inherit broader retained totals.
- `2026-07-07` - `Retained job list truncation signal`: Added a confirmed truncation flag and structured warning for bounded unpaginated retained-job reads when storage counts prove older rows were omitted.
- `2026-07-07` - `Premium retained job list guardrails`: Added an absolute retained limit to unpaginated job list reads and a retained-list ordered index for Premium dashboard reads.
- `2026-07-07` - `Job route body size limits`: Added 16kb Next.js body-parser limits to the job collection and item API routes with focused route-contract coverage.
- `2026-07-07` - `Latency audit review corrections`: Updated the latency-audit implementation plan with append-only retained-index migration guidance, retry/sampling/error-precedence specs, and explicit deferrals for summary caching and PUT hot-path consolidation.
- `2026-07-05` - `CSRF signature comparison byte-length fix`: Completed the multibyte CSRF hardening by converting the HMAC signature comparison in `validateCsrfToken` to UTF-8 buffer byte-length checks, closing the remaining `timingSafeEqual` RangeError path; added an identical-token multibyte signature regression test.
- `2026-07-05` - `Stripe audit follow-ups`: Made expired Checkout webhooks retry local terminalization failures, hardened CSRF timing-safe comparisons for multibyte input, tagged new Stripe customers with a non-PII app-user hash, and documented webhook rate-limit handling.
- `2026-07-05` - `Locked delete denial coverage`: Added deleteJob unit coverage for locked-row deletion under confirmed non-premium, non-terminal storage status returning JobLockedByPlanError.
- `2026-07-05` - `Rate-limit 429 helper reuse`: Reused the shared rate-limit exceeded helper for ordinary route throttling so 429 headers, logging, and error responses stay aligned with auth-failure throttling.
- `2026-07-05` - `Agentic loop Stage S setup`: Reconciled `CLAUDE.md` <-> `AGENTS.md` (kept the stronger of each drifted rule: CLAUDE section 2 `.env`, AGENTS section 5 per-function comments, AGENTS section 6 permission detail); added a `## Review guidelines` section to `AGENTS.md` for `@codex review`; scaffolded `docs/plans/` with plan/findings templates + README (the loop file-based message bus); added `.claude/commands/` shortcuts `plan-feature`, `converge`, `pr-fixes` mapped to Stages 0/2/3. Codex plugin + CodeRabbit CLI installs left for Will to run interactively.
- `2026-07-05` - `Update callback error boundary`: Kept successful job update callbacks outside the PUT failure path so local callback exceptions are not surfaced as failed network updates.
- `2026-07-05` - `Codex temp setup note`: Documented the repo-local `.tmp/` launch setup in `AGENTS.md` to avoid Windows split-root `apply_patch` sandbox failures.
- `2026-07-05` - `Workspace-local temp ignore`: Added an ignored `.tmp/` workspace folder for local temporary files so future Codex launches can keep temp writes inside the repo.
- `2026-07-05` - `Agentic loop workflow runbook`: Added `docs/agentic-loop-workflow.md`, a staged Codex x Claude x CodeRabbit development process (adversarial planning, chunked implementation with hot review, pre-PR convergence gate, PR fix loop) with three human approval gates, plan-contract and findings-ledger templates, and sources.
- `2026-07-05` - `Salary range constraint validation split`: Split the jobs salary range CHECK rollout into a NOT VALID add migration plus a follow-up validation migration with defensive inverted-range repair.

### Week of 2026-06-29
- `2026-07-02` - `Security review race and policy fixes`: Added update double-submit/stale-fetch guards, IP throttling for failed protected-route auth, locked single-row delete storage-status gating, and a versioned jobs salary range constraint.
- `2026-07-01` - `Job delete response and mutation race hardening`: Removed DELETE storage-summary work from the synchronous response path, kept delete payloads id-only, shared success-response metadata shaping, and guarded job add/delete mutations against stale full-fetch overwrites and duplicate submits.
- `2026-07-01` - `Onboarding design plan`: Added a design document for first-run dashboard onboarding, persistent info/help access, implementation chunks, review points, reference files, and testing guidance.
- `2026-07-01` - `Job delete storage summary response`: Added optional repaired count-only storage summary metadata to successful job-delete responses so clients can skip redundant status refreshes when safe.
- `2026-06-30` - `Job create storage summary response`: Added optional storage summary metadata to successful job-create responses and used it client-side to avoid a redundant status refresh when present.
- `2026-06-30` - `Job list pagination service validation`: Added schema-backed service validation so malformed pagination options fail before querying.
- `2026-06-30` - `Conditional job list counts`: Avoided exact database counts for unpaginated job list reads while preserving exact totals for paginated requests.
- `2026-06-30` - `Job ordered-read index`: Added an active dashboard list index and deterministic `id DESC` list tie-breaker for stable job reads.

- `2026-06-30` - `Storage-count user-id validation`: Added schema-backed validation at the storage-count service entrypoint so malformed user ids fail before the admin RPC.

### Week of 2026-06-22

- `2026-06-25` - `Job storage count RPC`: Added a service-role storage-count RPC and wired storage summaries to load active, locked, and retained job counts in one fail-closed call.
- `2026-06-24` - `Premium storage Chunk 11 coverage hardening`: Gated the remaining destructive DB suites, updated final restore RPC evidence, and added concurrency, strict-route, and hostile-CSV coverage.
- `2026-06-24` - `Destructive DB integration fail-closed gating`: Required explicit destructive integration opt-in plus Supabase test project URL matching before live database suites can run.

- `2026-06-22` - `Premium storage final integration evidence`: Added a final-state integration suite covering the complete storage-degradation migration stack, SQL storage-status matrix, service-role RPC boundaries, real locked-row projections, export visibility, and deterministic id tie-breakers.

### Week of 2026-06-15

- `2026-06-21` - `Locked archive review hardening`: Added callback rejection boundary coverage and successful RPC count validation for locked archive bulk deletes.
- `2026-06-21` - `Locked archive bulk-delete hardening`: Added a ref-backed UI duplicate-submit guard and multi-pass bounded service deletion for oversized locked archives.
- `2026-06-21` - `Locked archive bulk delete`: Added the confirmed terminal-Free locked archive bulk-delete API, bounded service-role RPC, dedicated rate limit, second-confirmation archive UI, and focused regression coverage.
- `2026-06-21` - `Chunk 9 jobs fetch rejection and stale loading guard`: Normalized rejected full job fetches and kept stale full-fetch responses from clearing loading while newer fetches are pending.
- `2026-06-20` - `Chunk 9 full-fetch freshness guard`: Split full job fetch and storage-summary freshness refs and covered loading cleanup when refreshes complete during refetch.
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
