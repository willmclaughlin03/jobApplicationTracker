# CHUNK-1 Temporary Session Ceiling Evidence

## Status

- Implementation date: 2026-08-09
- Stacked base: `agent/chunk0-auth-error-contract-tests` at `a6fca63e`
- Implementation branch: `agent/chunk1-temporary-session-ceiling`
- Operational and rollback owner: Will
- Pre-production alert destination: `tracktheapp.support@gmail.com`
- Environment boundary: pre-production only; there are no current paid users
- Remote `GATE-1`: **not passed**. Local implementation and controlled-load
  evidence do not prove the deployed CloudFront header, origin isolation, or
  edge enforcement.

The user-approved application ceiling is **400 combined v1/v2 session GETs per
source IP during a rolling 60-second window**. This replaces CHUNK-1's original
provisional application value of 1,000. The future WAF Block ceiling remains a
separate provisional **1,000 requests/60 seconds/IP** until Count-mode and
shared-NAT evidence support a final value.

## Protected request contract

The application ceiling protects:

- `GET /api/auth/session`; and
- `GET /api/auth/v2/session` when CHUNK-2 creates that isolated endpoint.

Both versions consume the same per-instance address map. The v2 route is not
created by CHUNK-1. Unsupported methods receive `405` before the ceiling, and
other routes, pages, assets, and sign-out requests do not consume this quota.

Every accepted method consumes capacity before cookie inspection,
`skipRateLimitWhen`, Redis, Supabase, or the route handler. Consequently, an
absent, valid, expired, malformed, or attacker-controlled cookie cannot disable
the control. A successful ceiling decision can only continue the ordinary
middleware path; it cannot skip the Redis limiter itself.

## Threshold and shared-NAT margin

The controlled 50-session profile models 50 simultaneous starts behind one IP,
followed by one verification per session every 30 seconds for ten minutes:

- steady request shape: approximately 100 checks/minute;
- plausible timing burst used during planning: approximately 150 checks/minute;
- application ceiling: 400 checks/minute;
- steady-state margin: 4x; and
- timing-burst margin: approximately 2.7x.

Any legitimate `429` or `503` in this controlled profile fails the gate. A
separate deliberate burst verifies requests 1-400 are accepted and request 401
is actively rejected with `429` and a valid `Retry-After`.

## Bounded-state design

Each address owns exactly 60 one-second slots backed by a `Float64Array` of
epochs and a `Uint16Array` of counts. The raw ring payload at the 10,000-address
cap is approximately 6 MB, plus JavaScript object, typed-array, and `Map`
overhead. Source identifiers remain only in process memory and never enter the
ceiling telemetry.

- Maximum address entries: 10,000 per server instance.
- Cleanup timers: none.
- Cleanup: on the first observed request in a new second, scan at most 10,000
  entries and remove addresses inactive beyond the conservative 60-second
  boundary.
- Live-entry behavior: never evict a live address to admit a new one.
- At capacity: existing addresses continue normally; a new address receives
  fail-closed `503` until state expires.
- Clock, source-mode, or internal-state uncertainty: fail-closed `503`. If the
  wall clock moves backward, requests remain unavailable until it catches the
  last observed second or the instance restarts.
- Rolling precision: one-second buckets retain the oldest bucket for less than
  one extra second. A source already at 400 may wait that fraction longer, but
  the implementation cannot admit two 400-request bursts less than 60 seconds
  apart and avoids unbounded per-request timestamp storage.

Instance restart clears all counters. The limiter is not fleet-global, so a
viewer reaching multiple live instances can receive an effective allowance of
up to **400 x active instance count**. This temporary mechanism cannot be the
sole abuse control for a paid-user production rollout.

The v1 and future v2 imports share one singleton only when the deployment
packages them into the same process/module runtime. If Amplify isolates route
bundles into separate compute processes, the overlap receives one 400-request
map per process/version. Remote topology evidence or one combined edge rule is
therefore required before claiming cross-version sharing outside local tests.

## Source identity boundary

Local development and tests accept only a validated and canonicalized
`req.socket.remoteAddress`. IPv4, IPv6, and IPv4-mapped IPv6 normalize into a
single address representation. All forwarding headers are ignored.

Every other runtime accepts exactly one `CloudFront-Viewer-Address` containing a
valid IPv4 or IPv6 address and source port from 1 through 65535. Missing,
repeated/array, comma-joined, whitespace-padded, malformed, portless, or
out-of-range values return `503`. Deployed evaluation never falls back to
`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, or the origin socket.

[AWS documents](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)
that this generated header contains the viewer IP and source port and must be
added through an origin request policy. The parser accepts strict unbracketed
`IP:port` plus bracketed IPv6 to tolerate the two unambiguous IPv6
serializations; both forms canonicalize to the same bucket.

This parser is not deployment proof. Before remote `GATE-1` can pass, executed
evidence must show:

1. the origin request policy supplies `CloudFront-Viewer-Address`;
2. CloudFront overwrites an attacker-supplied header;
3. callers cannot reach an origin bypass and forge the header; and
4. the application source agrees with WAF's native source-IP aggregation.

## Response contracts

The ceiling evaluator returns only an allow/deny decision. Route-specific
writers own public response bodies.

- V1 `429`: legacy `RATE_LIMIT_EXCEEDED` envelope plus integer
  `Retry-After` from 1 through 60.
- V1 `503`: legacy `SERVICE_UNAVAILABLE` envelope.
- All wrapper responses: `Cache-Control: private, no-store` before an early
  method, guard, auth, Redis, or handler outcome.
- Future v2 `429`: CHUNK-2 must write CHUNK-0's exact `RATE_LIMITED` body.
- Future v2 `503`: CHUNK-2 must write CHUNK-0's exact
  `SESSION_UNAVAILABLE` body.

## Telemetry and privacy

The module emits at most one `temporary_session_ceiling_summary` aggregate for
an active reporting window and at most one
`temporary_session_ceiling_rejection_sample` per instance/window. With no
background timer, the aggregate is emitted on the first request in a later
window; the final partial window is not emitted if the instance stops before
another request arrives.

Aggregate fields are count-only:

- `totalChecks`, `allowedChecks`, and `rejectedChecks`;
- `sourceResolutionFailures`, `stateCapacityFailures`, and `internalFailures`;
- `activeEntryCount` and `expiredEntryCleanupCount`; and
- bounded `routeVersionTotals` for `v1`, `v2`, and `unknown`.

The single rejection sample contains only outcome, reason code, route version,
and retry delay. Tests verify logs contain no raw or normalized IP, forwarding
address, cookie/token, session id/digest, email/user data, or limiter
configuration. Repeated hostile requests cannot create one warning each.

## Automated evidence

Focused execution after implementation:

```text
PASS src/server/middleware/__tests__/withRateLimit.test.js
PASS src/server/lib/__tests__/temporarySessionCeiling.test.js
PASS src/__tests__/pages/api/auth/session.test.js
PASS src/server/lib/__tests__/temporarySessionCeiling.load.test.js

Test Suites: 4 passed, 4 total
Tests:       141 passed, 141 total
```

Covered behaviors include the 400/401 boundary, rolling expiry,
independent/shared v1-v2 buckets, strict source parsing, forwarding-header and
cookie resistance, state-capacity failure, deterministic cleanup, no timers,
clock/internal failure, bounded logging, middleware ordering, legacy v1
responses, 1/2/4/8-tab loads, 50 shared-IP sessions, and 10,001 rotating source
attempts.

The pre-change CHUNK-0 focused baseline had 124 passing and seven failing tests.
CHUNK-1 closes its four private/no-store checkpoints. The three expected route
isolation failures remain assigned to CHUNK-2 (`v2/session`) and CHUNK-4
(`v2/signout`); CHUNK-1 does not create either endpoint.

Full unit comparison using the same command and unchanged CHUNK-0 base:

```text
CHUNK-0: 1,403 passed, 180 failed; 79 passed suites, 24 failed suites
CHUNK-1: 1,462 passed, 176 failed; 83 passed suites, 22 failed suites
Diff:    0 introduced failures; 4 intended cache-isolation failures resolved
```

Static and compilation checks:

```text
ESLint: passed with --max-warnings=0
Next.js 16.2.12 production build: passed
```

The build used the repository's non-secret CI placeholders because no build
variables were present in the local shell. It proves compilation, not deployed
secret/configuration readiness. The build emitted only the existing linked-
worktree root-inference, middleware deprecation, and Browserslist-data warnings.
None points to CHUNK-1. These local results must not be interpreted as remote
CloudFront/WAF evidence.

## Alerting and rollback

Monitoring queries, thresholds, destination, and limitations are recorded in
`docs/monitoring.md`.

Before CHUNK-2's no-cookie Redis bypass exists, a false-rejection or source-
resolution regression is rolled back by restoring the previous application
build. After that bypass exists, roll back or disable the bypass first, verify
the Redis-backed path protects session traffic again, and only then remove or
retune this ceiling. A WAF rule in Count mode is not a reason to remove active
application enforcement.
