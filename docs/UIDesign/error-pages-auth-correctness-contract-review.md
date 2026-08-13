# Error Pages and Authentication Correctness Contract Review

## Status

- Review date: 2026-08-12
- Branch: `agent/gate0-auth-contract-review`
- Base: `origin/staging` at `660e3133c8abcbe41927dac95a717beb89d1b61e`
- Scope: test-only contracts, sanitized installed-dependency evidence, fixture-integrity tests, and
  PR documentation
- Merge state: draft and unmerged
- Gate state: `GATE-0` remains open

This successor extracts only the green contract material from quarantined PR #134. It changes no
production behavior, contains no intentionally failing tests, and makes no deployed-environment
claim.

## Approved public contract

The repository owner approved the following terminal `user_banned` presentation in the Phase 3
implementation authorization:

- HTTP `403`
- v2 state `terminal_unauthenticated`
- error code `ACCOUNT_ACCESS_RESTRICTED`
- title `Account access unavailable`
- copy: “This account can’t access Track The App. Contact support if you think this is a mistake.”
- only the existing public support-mailbox action
- no ordinary sign-in controls

This approval freezes public behavior only. The server mapping remains disabled until a sanitized
deployed `user_banned` exported-class/code/status tuple and activation evidence are reviewed.

## Frozen schema decisions

The strict fixture module freezes literal version `2` responses and rejects extra or mistyped
fields.

### Session

- authenticated: HTTP `200`, `status: authenticated`, and only safe `id`, nullable `email`,
  and normalized `role`
- anonymous: HTTP `200`, `status: anonymous`
- unavailable: HTTP `429` or `503` with the matching bounded code and required headers
- terminal account restriction: the approved HTTP `403` contract above
- rejected method: HTTP `405` with `Allow: GET`

### Sign-out

- complete: HTTP `200`, local cleanup issued, and a typed remote result of `confirmed`,
  `already_invalid`, or `not_needed`
- local-only: HTTP `200`, local cleanup issued, and typed remote result `unconfirmed`
- rejected/unavailable: exact HTTP `400`, `403`, or `405`
  response pairs with matching headers and codes
- legacy success/error envelopes and status/body mismatches are rejected

## State, identity, and request policy

- Seven mutually exclusive client states are frozen: `loading`, `authenticated`, `anonymous`,
  `unavailable`, `signed_out_local`, `logout_unconfirmed`, and
  `terminal_unauthenticated`.
- Old-subject state is disposed before an authenticated subject change, role demotion, confirmed
  anonymity, or terminal restriction can expose a new state.
- Drafts are bounded, keyed to the owning subject/work epoch, quarantined across uncertainty, and
  never replayed automatically.
- Role normalization accepts only exact `user` and `admin`; it performs no trimming or case
  folding.
- Logout requires `POST`, exact `X-Logout-Intent: 1`, an empty body or exact empty JSON object,
  and at least one valid same-origin browser-source proof. Every present source proof must agree.
- Rejected logout requests perform no Supabase, Redis, auth-cookie, or CSRF mutation.

## Cookie namespace and evidence boundary

- Exact pre-production storage key: `sb-apxfjggdcybjticrnbpk-auth-token`
- Installed SSR encoded chunk size: `3,180` characters
- `MAX_AUTH_COOKIE_CHUNKS`: an explicit nonnumeric unresolved record owned by `CHUNK-2`

The bound may become a positive integer only after the approved largest legitimate deployed
session is passed through the installed `createChunks()` implementation. No raw cookie, session,
token, claim, or environment value may enter the evidence record.

## Supabase evidence

Sanitized installed-source evidence supports only this ordinary-anonymous tuple:

| Endpoint scope | Exported class | Code | Status | Disposition |
| --- | --- | --- | --- | --- |
| v2 session lookup | `AuthSessionMissingError` | absent | `400` | `anonymous` |

The deployed allowlist is empty. Candidate values such as `session_not_found` and `user_banned`
remain disabled. Documentation, messages, status alone, or a tuple observed on another Supabase
operation cannot activate a classifier.

Installed-source records also freeze:

- `@supabase/auth-js` `2.90.1`
- `@supabase/ssr` `0.8.0`
- sign-out default scope `global`
- SDK-suppressed sign-out statuses `401`, `403`, and `404`
- SSR chunking via `encodeURIComponent` at `3,180` encoded characters

These are repository/dependency observations, not deployed evidence.

## Route, cache, and renderer contracts

- Public, protected, unmatched, and raw-rejected route sets are disjoint.
- The two public-route fixture sources are required to remain equal so they cannot diverge
  silently.
- Every inventoried auth consumer has one seven-state policy row and one reset strategy.
- Every inventoried auth-capable response path has an owner, outcome set, dependencies, and
  `private, no-store` target behavior.
- CHUNK-6 owns production route discovery, middleware/provider bypass, and shared cache behavior.
- CHUNK-7 owns complete retry removal: no retry prop, callback, button, label, or automatic retry
  remains, while the public title must render as one child.

## Remaining blockers

`GATE-0` does not pass and this draft must not merge while either blocker remains:

1. The endpoint-scoped deployed Supabase tuple allowlist, including `user_banned` activation
   evidence, is empty.
2. `MAX_AUTH_COOKIE_CHUNKS` lacks the installed-chunker/largest-legitimate-session evidence needed
   for a positive integer.

Capturing either item is an external-environment action requiring separate authorization.

## Local validation

- focused fixture suite: 38/38 passing
- changed-file ESLint: passing with zero warnings
- repository lint: passing with zero warnings
- `npm run test:ci`: 92 suites and 1,364 tests passing
- placeholder-only `npm run build`: passing
- the subprocess-sensitive unit suite and Turbopack build required an outside-sandbox rerun after
  the sandbox denied child-process creation; both passed unchanged
- diff, scope, production-file, and sensitive-data audits: passing
