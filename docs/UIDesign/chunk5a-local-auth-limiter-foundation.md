# Local CHUNK-5A auth-limiter foundation

Status: local implementation under the approved pre-production sequencing exception.
Created November 8, 2026, from staging `dc505ff7271b9c0adc45bd2a578e4bdafeefebe7`.
No existing route imports this evaluator. Gate 1 remains open and Gate 5A is not passed.

## Authority and scope

The controlling references are the local main checkout's
`docs/UIDesign/gate1-preproduction-continuation-amendment.md` (Local CHUNK-5A
sequencing exception) and
`docs/UIDesign/error-pages-auth-correctness-remediation-plan.md` (Canonical
CHUNK-5A and GATE-5A; merged Gate-0 authority and controlling supersession rules).
The historical plan SHA-256 is
`4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f`.
Those local planning documents may not accompany a clean clone. This document
records the implemented contract, not a replacement approval or deployed evidence.

The approved deliverable is five production modules, five test files, and this
document. It preserves the existing generic limiter, shared temporary 400-request
ceiling, 61-second temporary representation, route contracts, and public schemas.
The historical session_id identity, GCRA, generic AUTH operation, and old CHUNK-5
design are superseded. The browser qualification path remains parked as unqualified;
this implementation does not authorize another diagnostic or native attempt.

## Policy and caller contract

| Operation | Identity subject | Hourly | Daily |
| --- | --- | ---: | ---: |
| AUTH_SESSION | Authenticated SafeUser UUID | 300 | 2,500 |
| AUTH_LOGOUT | Trusted source | 30 | 100 |
| AUTH_FAILURE | Trusted source | 15 | 30 |
| AUTH_CALLBACK | Trusted source | 30 | 100 |
| PRE_AUTH | Trusted source | 3,000 | 30,000 |

`free`, `paid`, and `admin` each explicitly select these immutable policies. Unknown,
missing, or null operations/tiers return unavailable; there is no unbounded tier.
Tier is absent from the Redis identity so changing tier cannot obtain a new quota.

`evaluateAuthRateLimit(input, { signal? })` accepts a strict object containing:

- `operation` and `tier`: exact values above;
- `req`: request-like object required for source operations;
- `authenticatedUser`: strict existing SafeUser, required for AUTH_SESSION;
- `localCleanupAccepted`: boolean, required to equal true for AUTH_LOGOUT.

The factory `createAuthRateLimiter(options)` provides local/test dependency, mode,
environment, monotonic-clock, and shorter-timeout seams. They are trusted server
configuration, never request input. The production default uses the existing runtime
secret loader and Node monotonic `performance.now()`. No module import performs Redis
work. The evaluator does not authenticate, mutate cookies, write responses, or log.

SafeUser shape validation does not authenticate a caller. A later route must supply
the result of its single authoritative provider evaluation, never a decoded JWT,
cookie-derived ID, or user-supplied UUID. The logout boolean is a caller prerequisite,
not evidence of cookie deletion: the route must append the full accepted local cleanup
set before calling this evaluator. Missing cleanup is rejected before source access or
configuration/Redis work. Actual route ordering remains a later integration criterion.

Source and secret modes must both validate and agree. The source parser is reused
unchanged: deployed Vercel requires exactly one case-insensitive raw header occurrence,
exact normalized scalar agreement, and a valid port-free/whitespace-free singleton
address. No other forwarding header or deployed socket is a fallback. Local mode
uses only the socket; canonical IPv4-mapped IPv6 collapse is retained.

## Identity and configuration

Both identity classes use HMAC-SHA256, with canonical 32-byte key validation and
deployment-bound secret parsing reused from the temporary-session modules. The frame is:

1. Version byte `1`.
2. uint32-BE byte length plus UTF-8 domain `auth-rate-limit:v1`.
3. uint32-BE active generation.
4. uint32-BE length plus UTF-8 key ID.
5. uint32-BE length plus exact operation name.
6. Subject-kind byte: `0` for user, `4` or `6` for canonical source family.
7. uint32-BE length plus subject bytes: lowercase UUID UTF-8 or canonical address bytes.

Redis key: `arl:v1:<OPERATION>:<43-character unpadded base64url digest>`.
The subject, key ID, and generation are protected inside the digest. Email, role,
tier, route, instance, build, and deployment ID are absent from the frame. Only the
internal key crosses into Redis; results/errors/logs do not expose it. The distinct
domain prevents reuse of the temporary ceiling identity even with the same HMAC key.

The initial foundation accepts one active generation from the existing validator's
allowlist and requires `previous: null`. A rotating keyring fails before client
construction. This does **not** implement rotation continuity: replacing generation,
key ID, or material creates a new namespace of digests and resets allowances. Keep
that tuple stable across restarts/instances/rollbacks during future qualification.
A migration/rotation design is required before enabling rotation; no temporary-ceiling
rotation/reset acceptance is inherited for hourly/daily quotas.

One runtime HMAC/Redis pair is acquired and pinned throughout a decision. The client
validates the Redis payload with the existing strict Upstash-origin/token parser.
No new credential source, fallback, or environment file access is introduced.

## Atomic state, windows, and expiry

`AUTH_RATE_LIMIT_REDIS_SCRIPT` is one static versioned Lua string. Its SHA-1 is
computed from those exact bytes. Policies are embedded from the code-owned policy
table; caller-provided limits or timestamps are not accepted. One key and one
operation argument are required, and key namespace/operation agreement is checked.

Redis TIME supplies seconds and microseconds. Supported seconds are canonical
nonnegative integers through `4102444799` (end of 2099 UTC); microseconds are 0–999999.
The hour starts at `floor(seconds / 3600) * 3600`; the day starts at
`floor(seconds / 86400) * 86400`. Windows are UTC epoch-aligned and half-open.

One Redis string contains:

```text
1:<hourly-limit>:<daily-limit>:<hour-start>:<hour-count>:<day-start>:<day-count>
```

State is at most 96 bytes. Before GET, TYPE and STRLEN enforce the bounded string
shape. PTTL must be nonnegative and at most 86,400,000 milliseconds. Parsing rejects
extra fields, leading zeros, nonintegers, unknown versions, policy mismatch, future
or misaligned windows, impossible hour/day relationships, excessive counts, and
daily count smaller than the stored hourly count. Existing malformed state is left
untouched and returns unavailable. Earlier windows are ignored only after validation.
Numeric parsing/serialization uses exact decimal formatting and bounded double
arithmetic, including in test Lua VMs with 32-bit integer arithmetic.

The script computes both window decisions before writing. If either quota is
exhausted, it does not change either count or the expiry. Otherwise it increments
both in memory and uses **one SET with PX** to install the complete value and expiry.
Separate writes are deliberately avoided because Lua atomic execution does not roll
back earlier writes after a later Redis command error. A failed sole write leaves
both stored counters and expiry unchanged.

Expiry is `dayResetSeconds * 1000 - RedisTimeMilliseconds`, in 1–86,400,000 ms.
It tracks the aligned day rather than extending for 24 hours on each request. It is
a relative TTL based on the sampled Redis time; exact logical rollover is also
enforced by the stored window labels. At most one key/value exists per operation,
subject, and active HMAC tuple. There is no global bound on distinct incoming subjects;
real cardinality, shared-IP capacity, latency, and cost remain hosted evidence work.

## Results and uncertainty

The Lua result is exactly eight integers:

```text
[1, status, nowSeconds, hourlyRemaining, dailyRemaining,
 hourlyResetSeconds, dailyResetSeconds, retryAfterSeconds]
```

Status `0` means allowed; `1` means denied. Invalid stored/input state returns
`[1,2,0,0,0,0,0,0]`, which the application converts to unavailable. The parser checks
tuple length/type/version, bounds, coherent counts and reset times, and retry value.
The last allowed request may return zero remaining while still being allowed.

Application results are frozen:

```js
{ status: 'allowed', hourly: { limit, remaining, resetAtSeconds },
  daily: { limit, remaining, resetAtSeconds } }
{ status: 'rate_limited', hourly: { limit, remaining, resetAtSeconds },
  daily: { limit, remaining, resetAtSeconds }, retryAfterSeconds }
{ status: 'unavailable' }
```

Only denied results include `retryAfterSeconds`: an integer 1–86400, equal to the
latest reset among exhausted windows minus Redis seconds. Rounding conservatively
to whole seconds avoids early retries. A later route serializes it as one decimal
Retry-After delta value and supplies the frozen private/no-store response contract.
There is no Retry-After or quota metadata on unavailable results, and this foundation
does not itself set HTTP headers or choose route-specific error bodies.

One total monotonic deadline covers configuration, client construction, EVALSHA, and
any permitted EVAL. The default and maximum are 1500 ms; a factory may choose a
shorter positive integer timeout. Each stage checks the absolute deadline before
starting and after resolving. Cancellation/deadline failure releases listeners and
timers and aborts the request-owned signal. Late stages cannot launch subsequent
work or return an allowed outcome. A Redis write already sent cannot be undone or
proven absent by cancellation; that uncertainty stays unavailable without retry.

The locked `@upstash/redis` v1.36.2 SDK uses an inclusive retry loop: `retry: false`
would perform two fetches on transport failure. The separate client uses
`retry: { retries: 0 }`, disables automatic pipelining/deserialization/telemetry,
and passes the same request AbortSignal. Fetch-count tests exercise the actual SDK.
The SDK exports its error classes under `errors.UpstashError`.

EVALSHA is attempted once. Only a SDK UpstashError beginning with the exact NOSCRIPT
code is reduced at the transport boundary to a private sentinel authorizing one
EVAL of the static script. Generic transport errors containing NOSCRIPT, other Redis
errors, malformed output, timeout, cancellation, and lost responses never authorize
a fallback. EVAL failure is never retried. Provider error messages and causes are
discarded; callers receive only fixed unavailable errors or the bounded result.

## Local validation and remaining work

Dependencies were installed with `npm ci --no-audit --no-fund`, using a repo-local
cache and TEMP/TMP. The first sandbox attempt failed at process spawn; the authorized
retry completed, including postinstall. Package manifests and lockfile are unchanged.

The five new suites cover policies/tiers, frame bytes, source equivalence, HMAC
separation, invalid inputs/configuration, exact hourly/daily boundaries, concurrent
local decisions, all-or-none denial/write failure, bad state, expiry/cardinality,
SDK fetch counts, exact NOSCRIPT fallback, deadlines/cancellation/late completion,
and privacy-safe results/errors. A composed test exercises the evaluator, synthetic
secret loader, actual SDK serialization, and actual production Lua with fetch replaced
by an in-memory Redis bridge. No HTTP is sent.

`ioredis-mock` rounds epoch seconds and derives microseconds from unrelated hrtime.
Subsecond boundary tests therefore adapt only its TIME command to coherent synthetic
seconds/microseconds, then execute the production Lua unchanged. They do not substitute
a JavaScript limiter. A separate composed test executes the unmodified production
script at a whole-second clock. Mock concurrency demonstrates local serialized Lua
behavior, not distributed Upstash/platform qualification.

Validation completed November 8, 2026:

- 23 Jest suites / 457 tests passed, using explicit paths with `--runInBand
  --no-cache --silent`: 157 new tests and 300 existing regression tests.
- Existing regression suites: temporarySessionSource, temporarySessionIdentity,
  temporarySessionSecrets, temporarySessionRedisScript, temporarySessionCeiling,
  temporarySessionCeiling.load, temporarySessionTelemetry, redis, rateLimit,
  authSafeUser, authSessionClassifier, authRequestPolicy, authProviderError,
  authProviderOperationTracker, both shared authV2 schema/constant suites,
  authV2ProductionParity, and authV2ContractFixtures.
- Focused ESLint on the ten new JavaScript files passed with `--max-warnings=0`.
- `git diff --check` and individual new-file whitespace checks passed.
- No existing tracked files, package manifests, or lockfile changed. Import search
  found no new-limiter references in existing routes or middleware.
- Local implementation validation performed no credentialed integration suite,
  browser exercise, live Redis request, deployment, route activation, PR, or push.
  The owner subsequently authorized publication as a new PR targeting staging.
  Existing GitHub deployment records show Vercel previews for feature branches;
  publication may therefore build a preview, but the unused evaluator does not
  activate a request path or qualify any gate. No merge or production promotion
  is included in the publication request.

The five new suites can be rerun from the implementation worktree with:

```powershell
node node_modules/jest/bin/jest.js --runTestsByPath `
  src/server/lib/__tests__/authRateLimitPolicy.test.js `
  src/server/lib/__tests__/authRateLimitIdentity.test.js `
  src/server/lib/__tests__/authRateLimitRedisClient.test.js `
  src/server/lib/__tests__/authRateLimitRedisScript.test.js `
  src/server/lib/__tests__/authRateLimit.test.js --runInBand --no-cache
```

Remaining gates and follow-up boundaries:

- Deployed Gate 1 source/WAF identity, environment isolation, cache/cookies, limiter
  load, observability, rollback, and other named platform obligations remain open.
- Gate 5A requires hosted source/secret and real Redis boundary/fault/cardinality
  evidence, plus route-correct failure and accepted logout cleanup ordering.
- Later CHUNK-2 owns dark v2 session/PRE_AUTH/AUTH_FAILURE/AUTH_SESSION integration
  and hosted mixed v1/v2 temporary-ceiling proof. Authenticated CSRF uses AUTH_SESSION.
- CHUNK-4 owns actual cleanup-before-source/Redis/provider ordering and sign-out
  outcomes. CHUNK-6 owns callback integration; CHUNK-5B owns final integrated WAF/load
  evidence and tuning. Existing temporary controls remain active.
- Before publication, obtain the applicable authorization and account for automatic
  deployments. Local eligibility does not authorize activation, PR deployment, client
  cutover, production rollout, or browser retries. Feature/fix logs are updated only
  for an authorized PR push.
