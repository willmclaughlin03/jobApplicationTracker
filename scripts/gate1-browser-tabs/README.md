# GATE-1 browser tab runner

This helper prepares the 1/2/4/8-tab browser qualification and provides offline
checks. Publishing it does not run or approve hosted traffic. GATE-1 remains open;
the scanner investigation remains closed as inconclusive and WAF source attribution
is still unqualified. No application routes, WAF rules or deployment settings change.

## Request-client isolation scaffold (2026-10-31)

`request-client-isolation.cjs` is a separate, local-only fixture scaffold for the
stopped CSRF investigation. It does not change the load runner's no-service-worker
guard, provide a hosted mode, or establish that a historical worker caused the
CSRF validation failure.

The fixture starts a new synthetic Edge profile with an HTTP rejecting proxy and
no direct fallback. Its first launch permits only the exact loopback fixture
origin so it can seed a synthetic cookie and service worker. The intended second
launch removes that exception and checks page HTTP, HTTPS CONNECT and restored
service-worker blocking while the request client exchanges synthetic cookies.
Limits are two launches, 100 fixture requests, 200 proxy connections and 15 minutes.
Cleanup requests normal browser closure and preserves the synthetic profile.
Worker observations contain category counts, validated numeric HTTP status,
success booleans and fixed failure categories. Evaluation failures and timeouts
are recorded before stopping and cannot qualify blocking. Raw URLs, error messages
and cookie values are not included in the result. Source hashes identify the
executed helper and adjacent tests.

The second launch now uses a disposable page for HTTP/HTTPS rejection probes and
leaves the blank keeper untouched. It requires normal probe-page closure and the
keeper to be the sole surviving blank page before starting restored-worker setup.
There is no recovery navigation or substitution of whole-browser cleanup for the
individual page-close requirement.

Restored-worker preparation records the first failing operation in
`restoredWorkerFailure`: probe-page creation, probe-page closure, control-page
readiness, CDP session creation, worker enable, worker start, worker discovery or
the fetch probe and its isolation assertions.
The record retains only a fixed operation label, `timeout`/`guard`/`other` category
and elapsed milliseconds. It survives cleanup and late completion without changing
the existing operation deadlines or probe checks. These labels identify the failed
step, not its underlying cause, and cannot retrospectively explain earlier receipts.

Validate the published helper without launching Edge:

```powershell
node --check scripts/gate1-browser-tabs/request-client-isolation.cjs
node --check scripts/gate1-browser-tabs/__tests__/request-client-isolation.test.cjs
node --test scripts/gate1-browser-tabs/__tests__/request-client-isolation.test.cjs
```

All 77 isolation-helper unit tests, syntax, focused lint and whitespace checks passed. Tests cover
native Fetch status properties, HTTP failures, fetch/evaluation rejection, timeout
and late completion, sanitized results, source hashes and receipt preservation.
Mocked orchestration also checks each restored-operation failure through receipt
serialization, cleanup precedence, unchanged proxy-evidence guards and successful
sequencing. Page-separation regressions cover expected navigation errors, invalid
probe/control states, closure failures and unchanged proxy/origin evidence guards.
These mocked outcomes are not native browser qualification.

The first native fixture stopped at `worker_baseline`; its stopped receipt remains
unchanged. The subsequent fix replaced the invalid `response.status()` call with
the native Fetch `response.status` property. That helper defect does not establish
the cause of the earlier hosted CSRF failure.

The separately approved replacement ran on October 28, 2026, at 10:30 PM EDT
(`2026-10-29T02:30:01.838Z`), for 3.49 seconds. It passed the initial worker fetch
(HTTP 200), normal restart, synthetic cookie persistence, request-client access and
cookie write-back, browser HTTP blocking and HTTPS CONNECT blocking. It then
**stopped at `fixture_operation_failed`** after the HTTPS check, before recording
a restored-worker probe. The exact failing operation is unknown; restored-worker
isolation remains unqualified. Counts were two launches, six fixture HTTP requests
and 30 proxy connections. Normal closure, zero matching task processes and
preservation of the profiles and historical receipts were verified. No hosted test
ran, and GATE-1 remains open.

Attempt3 ran on October 31 at `2026-10-31T15:43:56.106Z`, for 4,065 ms. It retained
`blank_navigation` / `other` / 47 ms after HTTP/HTTPS blocking, before worker setup.
The raw error is unavailable. Counts were two launches, six fixture requests and
31 proxy connections. Do not retrospectively assign this operation to attempt2.

After page separation, attempt4 ran at `2026-10-31T15:56:43.947Z`, for 11,466 ms.
It passed disposable-page creation and HTTP/HTTPS blocking, then stopped at
`probe_page_close_timeout` with `probe_page_close` / `timeout` / 5,008 ms. Counts
were two launches, six fixture requests and 49 proxy connections. Control readiness
and restored-worker setup were not reached. Both attempts recorded successful
normal browser cleanup and profile/evidence preservation. Browser cleanup does not
establish that the individual page closed within its five-second deadline.

This publication retains the reviewed local helper's fixed Windows tool paths,
Playwright version, ten historical evidence prerequisites and one fixed result
destination. It is not a portable browser launcher. The native entry point was
used from `.tmp/gate1-browser-tabs/request-client-isolation.cjs` in the approved
workspace; do not run the published copy directly or copy historical receipts into
a clean checkout to manufacture execution context. Unit tests require none of
those local receipts or browser tools.

All four stopped results remain local under `.tmp/gate1-checkout-enable-dd2c2c6/`:
`browser-isolation-fixture.json` and its `-attempt2`, `-attempt3` and `-attempt4`
counterparts. Profiles and operational receipts are not published. The current
helper hashes the first three stopped receipts along with seven earlier records.
Its fixed destination remains the already-existing `browser-isolation-fixture-attempt4.json`;
the exclusive-result guard refuses another run. All four native approvals are
consumed. Do not change that destination merely to permit attempt5.

## Page-lifecycle diagnostic preparation (2026-10-31)

`page-lifecycle-diagnostic.cjs` prepares a separate diagnostic for the unresolved
page-close timeout. It has not been run natively. Publication, passing offline
tests and a supplied source digest do not authorize execution. A new bounded owner
decision must cover the exact source hashes, toolchain, new synthetic profile,
evidence destination, cases, limits and stopping point. The operator is the Codex
agent and the operational owner is the project owner.

The prepared cases use one browser launch, one untouched blank keeper and at most
two open pages. Case1 closes a blank disposable page once. If it completes, case2
runs the existing HTTP and HTTPS CONNECT rejection probes on another page and
immediately calls the same `close({runBeforeUnload:false})`, without an intervening
navigation, sleep or protocol round trip. The rejecting loopback proxy is active
from launch with no loopback bypass or direct fallback. There are no scripted
cookie, request-client, worker, restart or hosted/provider exercises.

The observer wraps the pinned Playwright connection's protocol logger and restores
it during cleanup. It observes the actual root `Target.closeTarget` command and
response, matching root detachment, server/client close events, public promise
settlement and main-frame lifecycle categories. A bounded target inventory uses
that same connection. Raw protocol payloads, URLs, IDs, cookies and errors are not
retained. Unknown failures become fixed categories. A timeout freezes the case
before a single post-failure inventory; that separately timed observation cannot
turn the timeout into a completed case. Cleanup-time events remain separate.

Limits are 90 seconds overall with a 20-second cleanup reserve, five-second page
operations, one-second inventories, two scripted navigations, 10 fixture HTTP
requests, 100 proxy connections, one cached browser-version read, two target
inventories, 256 retained events and 128 KiB of evidence. Incoming cleanup traffic
is counted. Playwright attachment still performs its own initialization commands;
these counters describe diagnostic-issued version/inventory reads. Resource or
recorder overflow stops the exercise as inconclusive.

The immutable receipt is reserved before launch at
`.tmp/gate1-checkout-enable-dd2c2c6/browser-page-lifecycle-diagnostic-01.json`.
Existing evidence prevents execution. All eleven predecessor receipts are checked
against frozen hashes before and after the exercise. Cleanup requests normal CDP
`Browser.close`, verifies owned-process exit, closes owned loopback resources and
preserves the new `isolation-fixture-lifecycle-*` profile. No force-kill or profile
deletion is used. Failed cleanup returns to an owner decision.

The local execution copy must remain under `.tmp/gate1-browser-tabs/`. Preflight
requires Node `v22.18.0`, Playwright `1.62.0-alpha-1783623505000`, the pinned
`coreBundle.js` and Edge executable SHA-256 values in `PIN`, and Edge
`156.0.4314.50`. The installed version is not proof of the browser version used by
every historical attempt. Disable `DEBUG`, `DEBUG_FILE` and `PWDEBUG` only in the
diagnostic process before loading Playwright; inherited debug logging is rejected.
Use repo-local `.tmp` for `TEMP` and `TMP`.

Before any execution decision, review the exact four helper/test files and freeze
the ordered manifest digest from `sourceHashes()`. The only native CLI form is
`--diagnostic --source-set-sha256=<reviewed-64-character-digest>`; arbitrary targets,
profiles and default execution are refused. The Windows paths and retained local
evidence make this a specific workspace diagnostic, not a portable launcher.
Recheck file bytes after checkout or copying rather than bypassing a digest mismatch.

Offline validation, which requires no native browser or local receipt files:

```powershell
node --check scripts/gate1-browser-tabs/page-lifecycle-diagnostic.cjs
node --check scripts/gate1-browser-tabs/__tests__/page-lifecycle-diagnostic.test.cjs
node --test scripts/gate1-browser-tabs/__tests__/request-client-isolation.test.cjs scripts/gate1-browser-tabs/__tests__/page-lifecycle-diagnostic.test.cjs
```

All 113 tests passed: 77 isolation-helper tests and 36 diagnostic tests. Coverage
includes command correlation, event ordering, missing replies/detachment/client
propagation, deadlines and late completion, cleanup failures, resource/recorder
limits, exclusive evidence reservation, source/history guards and hostile-data
redaction. Syntax, focused zero-warning lint and whitespace checks also passed.

If both reduced cases complete, the result is `not_reproduced`; failures are
`inconclusive`. Neither result qualifies restored-worker isolation or GATE-1.
This reduced setup omits restart and worker seeding and does not reproduce attempt3's
blank-navigation failure. No automatic retry, toolchain change, attempt5 or hosted
CSRF exercise follows. Browser-stack rejection is not proof of OS-wide egress
isolation. GATE-1 remains open.

## Offline commands

Run from the checkout root with Node 22. The unit suite uses built-in modules only
and runs separately from the repository's Jest suite:

```powershell
node --test scripts/gate1-browser-tabs/__tests__/runner.test.cjs
node scripts/gate1-browser-tabs/runner.cjs --describe
```

The native browser fixture requires an existing Microsoft Edge executable and an
existing `playwright-core` package directory, version
`1.62.0-alpha-1783623505000`. Supply absolute paths in this order; the runner does
not install dependencies or search personal profiles, credential files or environment
variables. Replace the placeholder paths with your locally approved tools:

```powershell
node scripts/gate1-browser-tabs/runner.cjs --self-check `
  --playwright-core 'C:\path\to\node_modules\playwright-core' `
  --edge-executable 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

The fixture binds to loopback, serves synthetic session/CSRF responses, and starts
an owned empty Edge profile under this checkout's ignored `.tmp/gate1-browser-tabs/`.
It attaches using `noDefaults: true` so Playwright does not force all tabs visible.
Real tab activation exercises the visibility throttle; a separate redirect case
checks that the next hop is blocked before dispatch when its budget is exhausted.
Cleanup closes owned tabs and the owned browser, then removes only its verified new
profile. Native Edge visibility behavior has been checked on Windows; other platforms
are not qualified. The shortened two-tab fixture is not hosted load evidence.

## Hosted execution contract

There is no live CLI mode. The exported `runProfiles` API additionally requires
separate explicit authorization, an owner-approved test identity and an exclusively
prepared browser context with exactly one blank page and no service workers. It
accepts only these exact ordered `approvedProfiles` lists and matching `approval`
values, exported by the module:

| Mode | approvedProfiles | approval |
| --- | --- | --- |
| Full exercise | `[1, 2, 4, 8]` | `LIVE_APPROVAL` |
| Remaining profiles | `[2, 4, 8]` | `REMAINING_APPROVAL` |

Missing, reordered, duplicate, incomplete or mismatched selections are rejected
before context inspection or requests. An approval marker is a caller assertion,
not a substitute for owner authorization. The remaining mode reuses the same frozen
profiles and guards; it does not rerun 1-tab or import its historical pass. Reports
list only profiles completed in that invocation, with partial request observations
and the first stop reason retained separately. Account preparation and authentication
are outside `runProfiles`. Never supply a personal browser context.

### Dedicated browser preparation

The exported `launchNativeBrowser({ corePath, browserPath, manualFirst: true })`
opens a new owned profile with local instructions for Vercel access to the generated
host and application sign-in on the canonical host. This phase has no remote-debugging
port or automation connection. The owner signs in normally, then closes every window
of that dedicated browser. Do not read credential files or export cookies.

The returned handle exposes `status()`, `attachAfterManualSignIn()` and `close()`.
Call `attachAfterManualSignIn()` only after `status().manualExitClean` is true.
The one-shot transition rejects a running browser or an unclean exit and restarts
the same profile with automation. It creates one blank keeper and exposes `browser`,
`context`, `keepAlive`, `status` and `close`. Verify actual application authentication
and the owner-approved identity in memory; cookie presence alone is insufficient.

`close()` is final cleanup: it closes only the owned process and deletes only its
verified profile after exit. Calling it between manual sign-in and attachment would
erase the saved sign-in state. Preserve primary startup failures and report any
cleanup failure separately. Manual sign-in traffic is real hosted preparation,
not a loopback test or a completed load profile.

### Pinned target and build probes

The recorded target is commit `bc598fabcf4467334ea531a5737e141cd049f1c5`, build
`3LRfqNqxpvyMmJr3CCNiQ`, on these origins:

- Canonical: `https://job-application-tracker-kappa-seven.vercel.app`
- Generated: `https://job-application-tracker-bbjxq0mgy-track-the-app.vercel.app`

The [Vercel deployment reference](https://vercel.com/track-the-app/job-application-tracker/HQysMrfSb2Kjvk2dX7E9oG8bJMtE)
and GitHub deployment `7262951491` identify the recorded target. Its actual Vercel
`dpl_` ID has not been independently retrieved, so `TARGET.deployment` is null.
These pins are not a claim that a later staging build or publication serves the same
target. Reconcile deployment changes before separately authorized hosted execution.

Canonical probes remain anonymous. Each generated-host probe privately reads the
prepared context's `_vercel_jwt` and sends only that cookie to the exact generated
origin. It requires one exact-host, root-path, Secure, HttpOnly, unpartitioned cookie
with a safe value and sufficient remaining lifetime (or a session lifetime). Missing,
ambiguous or invalid authentication stops before fetch. Cookie lookup, fetch and
bounded body reads share a five-second deadline; redirects are never followed.

Both `/login` probes use a unique query value and request revalidation. Before any
profile browser work, each response must have the static route's expected
`Cache-Control: public, max-age=0, must-revalidate` (case, spacing and directive
order may vary), the exact pinned build and one of these cache states:

- `MISS`, `BYPASS` or `REVALIDATED`: `Age` must be absent or exactly zero.
- `HIT`: `Age` must be present and contain only decimal digits representing a
  nonnegative safe integer; a positive age is allowed only in this case.

Vercel [caches static files for the deployment lifetime](https://vercel.com/docs/caching/cdn-cache)
and [ignores static-file query strings in deployment-specific cache keys](https://vercel.com/docs/caching/cdn-cache/purge).
A static cache hit therefore qualifies build attribution, not fresh origin execution.
Missing or conflicting policy/status headers, stale or unknown cache states and
invalid ages still stop with `cached_target`; a different build stops with
`build_mismatch`. The same checks run after each profile. This exception concerns
static login probes only and does not qualify caching of authentication responses.

The proposed whole-run limits are 55 minutes, 1,000 application requests, 1,280
static requests and 364 session requests. The full profile caps total 980 application,
1,200 static and 360 session requests, leaving planned readiness allowances of
20/80/4. `runProfiles` creates a new budget and begins the first selected profile;
it does not automatically import earlier attempts, manual sign-in or external
readiness counts or elapsed time. Reconcile these with the authorized cumulative
budget before calling it; choosing a continuation never resets prior consumption.
These limits need their own hosted approval and do not override an earlier ceiling.
Per-profile limits and rolling 61-second caps reserve requests synchronously before
dispatch. HTTP errors, unexpected origins/methods/redirects, identity mismatches,
child targets, timeouts or exhausted limits stop the run.

The remaining `[2, 4, 8]` profiles have combined caps of 900 application / 1,120
static / 336 session requests. Session requests are included in application counts.
After the October 22 target check and stopped continuation, the ledger records
100 application / 112 static / 35 session actual requests, or 101 / 112 / 35
conservatively including one historical reserved-but-unsent application request.
Manual owner sign-in traffic is separate. Another preparation session plus the
remaining profile caps would permit cumulative maxima of 1,001 / 1,232 / 372 actual,
or 1,002 / 1,232 / 372 including that reservation. Both exceed the existing
application and session limits. A new complete remaining-profile attempt needs
explicit revised cumulative-budget approval as well as target/browser readiness,
frozen cases and separate execution authorization. Include any further diagnostic
traffic in that accounting; never reset the ledger or skip an unqualified profile.

Session latency includes full-response completion. CSRF latency ends at response
headers because the application leaves that body unread; the runner never reads the
CSRF token. Reports label both boundaries separately and apply the proposed 2-second
p95 / 5-second maximum to each. HTTP cache is disabled. Identity comparisons stay
in memory and reports retain only booleans, fixed categories, counts and timings;
they do not export session bodies, cookies, headers or account identifiers.

Passing local checks does not establish hosted identity isolation, WAF attribution,
provider capacity, deployment qualification or release approval.

### Failure diagnostics

Both hidden- and visible-state waits use 20 ms timer polling, independent of
animation-frame scheduling. Each retains its one-second deadline. Acceptance still
requires a newly recorded, trusted visible event after an observed hidden state;
timer polling does not manufacture events or relax the visibility contract.

Unexpected browser rejections during page setup, startup navigation and native
visibility operations receive fixed operation codes, such as `page_cdp_attach_failed`,
`startup_navigation_failed`, `visibility_hidden_wait_failed` and
`visibility_visible_wait_failed`. These identify the operation that rejected without
retaining its raw error, URL or account data. Recognized qualification
errors and the budget's first stop reason retain precedence; cleanup still closes
only owned test pages.

For a rejected visible-state wait, `visibilityFailure` retains one sanitized record
even when `profiles` is empty. It contains the allowlisted profile/tab, operation,
elapsed timing, synchronous page/browser availability and pre-activation visibility
scalars. `errorCategory` is `timeout` for the exact error name `TimeoutError`, `guard`
for a recognized qualification error, or `other`; arbitrary error names/messages,
stacks, URLs, cookies, headers and account data are discarded.

One best-effort scalar read is queued before cleanup and capped at 250 ms. The stop
reason is latched and owned-page cleanup starts without awaiting that read. Its
snapshot reports `available`, `invalid`, `unavailable` or `timeout`, with nulls for
missing/unrecognized scalar values. `afterFailureMs` identifies the delay after
rejection: this is a later observation, not a reconstruction of the state at the
wait deadline. Cleanup can win the race and make it unavailable. A visible snapshot
cannot qualify the failed activation. The frozen record cannot be changed by a late
read, and no extra activation or retry is attempted. Failed loopback reports retain
the same diagnostic record when present.

Operation codes do not establish an underlying application or browser cause, and
cannot retrospectively attribute an earlier `tool_failure`. The frozen profile,
timing and request limits remain unchanged. A stopped hosted exercise requires a
new decision and authorization before another attempt.

The earlier October 22 1-tab pass belongs to commit
`ce7ac0977fc538940e2acb339195cf2874c96aee`, build `NEMMu5_HCxJLWxeA7FEQD`.
That run stopped during 2-tab startup; 4/8 tabs were not executed. Local simulation
showed a conditional missed observation when animation frames were withheld, but
never established that as the hosted failure's cause.

The separately authorized continuation on the current recorded target used timer
polling and stopped again at `visibility_visible_wait_failed`, after approximately
199.260 seconds on October 22, 2026 (20:53:07.370–20:56:26.630 UTC). Its preparation
session succeeded, but no profile completed and 4/8 never started. Including
preparation, it issued 25 application / 38 static / 9 session requests; all 63 HTTP
responses were 200 and all observed session identities matched. Partial session
and CSRF samples met the latency criteria but do not qualify the unfinished profile.
Failure-time visibility scalars and the original browser error were not retained;
the underlying cause remains unknown. Preserve the historical report unchanged.

The new diagnostic capture passed all 67 offline tests, syntax, focused lint and
the native two-tab loopback fixture (six trusted transitions, six session requests,
owned cleanup and redirect-cap checks). It has not run against the hosted target.
No new hosted request was made for this diagnostic update. The earlier 1-tab pass
remains separately attributed; 2/4/8 qualification and GATE-1 remain open.
