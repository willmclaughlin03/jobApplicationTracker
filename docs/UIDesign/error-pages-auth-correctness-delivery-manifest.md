# Error Pages and Authentication Correctness Delivery Manifest

## Status

- Recovery record date: 2026-08-12
- Governing source: intentionally retained outside Git and excluded from this pull request
- Publication branch: `docs/error-auth-delivery-recovery`
- Fresh branch base: `origin/staging` at `c09209b69b4328b35b8c1cbcf551a07a5e16a30f`
- Scope: documentation-only delivery recovery; no production behavior, gate, deployment, or external
  evidence state is changed by this manifest

This manifest is the compact control record for rebuilding error-page/auth work from current
`staging`. The numbered chunks are workstreams and approval gates, not one-to-one pull requests.
Every successor pull request targeting `staging` must remain independently safe and green at its
head. Quarantined historical PRs listed below are excluded from this invariant.

## Delivery invariants

1. Start every successor branch from then-current `origin/staging`, never from a quarantined head.
2. Keep each successor staging-target pull request green. Focused red tests land with the production
   behavior that makes them green; red/green commits may remain visible inside a green final head.
3. Merge a contract-only PR only when the contract is frozen, the head is green, production files
   are absent, and no intentional failure remains.
4. Treat repository-local tests as local evidence. Deployment, Supabase, WAF, CloudFront, load, and
   pre-production observations remain unexecuted until separately authorized and captured.
5. Keep the temporary application ceiling at `400` combined v1/v2 session requests per source IP
   per 60 seconds. The separate provisional WAF ceilings remain `1,000` session and `500` sign-out
   requests per source IP per 60 seconds.

## Quarantined pull requests

### Pull request #134

[PR #134](https://github.com/willmclaughlin03/jobApplicationTracker/pull/134),
`agent/chunk0-auth-error-contract-tests`, is open draft history. Its head is intentionally red and
contains out-of-scope dashboard production changes. Do not merge, rebase, retarget, or resolve
review threads there. The Phase-1 disposition is recorded in
[the preserved comment](https://github.com/willmclaughlin03/jobApplicationTracker/pull/134#issuecomment-5272381697).

| Commit | Disposition |
| --- | --- |
| `69b0e1572cd3c3a606b60f2e78c5096a656d3b8c` | Original CHUNK-0 baseline and evidence history; do not merge wholesale. |
| `a6fca63e44ef55ec0009abcdce1da0d2f4763f0c` | Hardened contract-test history and historical #135 base; do not merge wholesale. |
| `0b9656b2cb20832519fa3ee29e7a9c7f44fbe2b1` | Review changes plus out-of-scope dashboard production work; extract by owner below. |
| `5c40a93c764bce70746275ef9f774127ad67aec6` | Dashboard redirect-effect history; reserve for the final CHUNK-3 dashboard layer. |
| `b0019ea76f50c4f9c8ba22c94924579ddfa297db` | Subject-reset history and quarantined head; extract by owner below. |

Close #134 only after this manifest is committed and a successor contract-review branch exists.
Preserve `agent/chunk0-auth-error-contract-tests` through CHUNK-8 as review/evidence history.

### Pull request #135

[PR #135](https://github.com/willmclaughlin03/jobApplicationTracker/pull/135),
`agent/chunk1-temporary-session-ceiling`, remains open draft history and must not be merged,
rebased, or retargeted. Commit `af89095696a5971b2612732080d75e43ebd707ee` is the CHUNK-1
donor. Reproduce only reviewed, still-applicable changes on a branch made from current staging; do
not cherry-pick the donor wholesale.

Close #135 only after the rebuilt CHUNK-1 replacement PR exists. Preserve
`agent/chunk1-temporary-session-ceiling` as the donor branch.

## Historical extraction map

| Historical material | Green successor owner |
| --- | --- |
| Strict schemas, sanitized evidence markers, and fixture integrity | Contract-review workstream |
| Temporary ceiling tests and guard | Rebuilt CHUNK-1 using `af89095696a5971b2612732080d75e43ebd707ee` as donor |
| V2 session behavior, cookie bounds, and endpoint/session isolation | CHUNK-2 |
| Auth provider, API cancellation, jobs, drafts, admin, billing, login, and dashboard tests | CHUNK-3 |
| `src/pages/index.js` production changes from `0b9656b2cb20832519fa3ee29e7a9c7f44fbe2b1` through `b0019ea76f50c4f9c8ba22c94924579ddfa297db` | Final CHUNK-3 dashboard layer after the provider layer |
| V1/v2 sign-out behavior and typed outcomes | CHUNK-4 |
| Middleware/route inventory, `_app`, callback/SSR, and shared cache safety | CHUNK-6 |
| `ErrorPage` retry removal and title shape | CHUNK-7 |
| Historical feature/fix log entries | Discard and regenerate from each successor PR's actual diff and validation |

## Unresolved #134 review threads

All five threads remain unresolved and not outdated on the quarantined PR. Their successor owners
must address the substance on green heads; this manifest does not resolve the historical threads.

| Thread | Historical location | Owner |
| --- | --- | --- |
| `PRRT_kwDOPzs7p86XsoDX` | `src/__tests__/middlewarePublicPaths.test.js:173` | CHUNK-6 |
| `PRRT_kwDOPzs7p86XsoDb` | `src/__tests__/pages/adminUserDetail.test.js:46` | CHUNK-3 |
| `PRRT_kwDOPzs7p86XsoEr` | `src/testSupport/__tests__/authV2EndpointIsolation.test.js:59` | Split between CHUNK-2 and CHUNK-4 |
| `PRRT_kwDOPzs7p86XsoEv` | `src/testSupport/authV2ContractFixtures.js:19` | CHUNK-2 evidence-derived bound |
| `PRRT_kwDOPzs7p86XsoEz` | `src/testSupport/authV2ContractFixtures.js:483` | Contract review for fixture integrity, then CHUNK-6 route ownership |

## Gate ledger

| Gate | Status at publication | Required next evidence |
| --- | --- | --- |
| `GATE-0` | Unresolved | Authoritative public contracts and copy; sanitized endpoint-scoped Supabase tuples; cookie bound; route/cache inventory; retry-removal contract. |
| `GATE-1` | Not passed | Green replacement CHUNK-1 plus separately authorized deployed load/source/topology evidence. The donor's local checks are not remote evidence. |
| `GATE-2` | Open / not executed | Green dark-v2 session successor and deployed-everywhere proof. |
| `GATE-3` | Open / not executed | Green provider/consumer/dashboard successors and approved client-switch evidence. |
| `GATE-4` | Open / not executed | Green local-first sign-out successor and deployed origin/route evidence. |
| `GATE-5` | Open / not executed | Green hierarchical limiter implementation plus approved Redis/WAF/telemetry evidence. |
| `GATE-6` | Open / not executed | Green route/cache successor plus executed CloudFront/cache proof. |
| `GATE-7` | Open / not executed | Green renderer successor plus production-like renderer evidence. |
| `GATE-8` | Open / not executed | Integrated v2-only release and all separately authorized operational gates. |

### `user_banned` contract discrepancy

The local untracked file `docs/UIDesign/error-pages-auth-correctness-chunk-0-review.md` claims that
the public contract was approved as HTTP `403`, v2 terminal-unauthenticated code
`ACCOUNT_ACCESS_RESTRICTED`, title `Account access unavailable`, explanatory Track The App copy,
and only the existing support-mailbox action. That local assertion is not committed review evidence,
and no authoritative GitHub approval establishes it. The retained local governing source continues
to mark the exact public response, client state, copy, and recovery action unresolved. Recovery
therefore keeps `GATE-0` open rather than inventing or claiming approval.

The sanitized deployed `user_banned` class/code/status tuple and activation evidence are also
missing. That evidence requirement is independent of the public-contract approval discrepancy.

## Ordered delivery route

```text
current origin/staging
  -> delivery plan/manifest PR
  -> GATE-0 authoritative decision
  -> rebuilt CHUNK-1 -> merge/deploy with separate approval -> GATE-1
  -> green contract-fixture successor
  -> CHUNK-2 -> GATE-2
  -> CHUNK-3 -> GATE-3
  -> CHUNK-4 -> GATE-4
  -> CHUNK-6 -> GATE-6

GATE-6
  -> CHUNK-5 -> GATE-5 -> CHUNK-8 -> GATE-8
  -> CHUNK-7 -> GATE-7 -> CHUNK-8 -> GATE-8
```

CHUNK-6 is logically eligible after `GATE-0`, but recovery schedules it after CHUNK-4 to reduce
shared adapter and route conflicts. CHUNK-5 remains logically dependent on CHUNK-2 and CHUNK-4 and
is intentionally scheduled after CHUNK-6. CHUNK-5 and CHUNK-7 may proceed independently after the
scheduled CHUNK-6 checkpoint and their own stated predecessors.

## Restricted native-stack policy

- Do not link #134 or #135 into a stack and do not create a cross-gate chain.
- If separately approved, native stacking is limited to short independently green layers within
  one approved chunk, such as CHUNK-3 provider, consumer, and final dashboard layers.
- Push through ordinary terminal Git. Do not use a stack extension to push or submit work.
- Installing a stack extension or linking branches requires separate approval. No installation or
  linking is part of this documentation PR.

## Publication evidence boundary

This PR may prove only documentation integrity, repository lint/tests/build, and its GitHub Actions
check. It does not close a numbered gate, deploy an endpoint, capture Supabase tuples, exercise WAF
or CloudFront, run remote load tests, change PR #134/#135, create a successor contract branch, or
merge any pull request.
