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
page-close timeout. The original preparation was executed once on November 1;
its result and the separately prepared comparison are recorded below. Publication, passing offline
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
the ordered manifest digest from `sourceHashes()`. The original Edge CLI form is
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

Initial preparation passed 113 tests: 77 isolation-helper tests and 36 diagnostic tests. Coverage
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

## Executed Edge diagnostic and comparison preparation (2026-11-01)

The one authorized Edge diagnostic ran from 17:47:13.115Z to 17:47:21.617Z
using the original execution copies. Its receipt is
`.tmp/gate1-checkout-enable-dd2c2c6/browser-page-lifecycle-diagnostic-01.json`,
SHA-256 `85918721972e74be6553afcf825f1c8501993645b575b0b4e7b3eae6430f4ea4`.
The blank page completed closure and target-absence checks in 20 ms. After the
HTTP/HTTPS rejection probes, the browser acknowledged `Target.closeTarget` with
`success: true`, but the page close timed out after 5,008 ms. A separately timed
inventory at 5,009 ms still found the target. Root detachment, server/client close
events and public-promise completion occurred only during whole-browser cleanup.
Navigation events continued after the close acknowledgment.

The result is `inconclusive`, with `blocked/close_timeout` as the first failure.
One launch, zero fixture requests and 35 proxy connections were recorded over
8,502 ms. Normal cleanup, profile preservation and all eleven older receipt
hashes passed. This supports a browser-side failure to complete the acknowledged
close; it does not identify a specific Chromium defect or qualify isolation.

Comparison preparation and offline validation were followed by one separately
authorized native attempt; its stopped outcome is recorded below. Recovery or
another exercise requires a new owner decision. The operator remains Codex and the operational owner remains the
project owner. Original execution copies under `.tmp/gate1-browser-tabs/`, all
receipts and retained profiles are preserved. The full fixture still defaults to
Edge and its already-existing attempt4 destination; no attempt5 is enabled.

### Verified comparison target and package provenance

The comparison uses **Chrome for Testing 158.0.8127.2, win64**, with the same
Node and Playwright pins as the Edge diagnostic. Google lists the exact version
and Windows archive in its [availability catalog](https://googlechromelabs.github.io/chrome-for-testing/).
The version tag resolves to Chromium commit
`681cd621e82e606d7536eae8ea2576afb3c7d65c`, whose history includes fix
`9f02826186a75a2f2958f3e42e8214f35ac88e97`. Its
[ClosePage implementation](https://github.com/chromium/chromium/blob/681cd621e82e606d7536eae8ea2576afb3c7d65c/content/browser/renderer_host/render_frame_host_impl.cc#L8028)
retains browser-initiated navigation cancellation and speculative-frame discard.
Both navigation/close
[regression tests](https://github.com/chromium/chromium/blob/681cd621e82e606d7536eae8ea2576afb3c7d65c/content/browser/renderer_host/render_frame_host_manager_browsertest.cc#L1885)
are present. This establishes inclusion of the fix in the selected source;
local effectiveness remains untested.

The archive was downloaded from Google's public bucket at
`https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.2/win64/chrome-win64.zip?generation=1793109899792412`.
Its 215,109,122 bytes matched the published object size and MD5
`GcawADx/eiQBdtUHE1l2zA==`. It is retained under
`.tmp/browser-tools/chrome-for-testing/158.0.8127.2/chrome-win64.zip`, with
305 extracted files totaling 470,456,803 bytes in the adjacent `chrome-win64/`.
Both `chrome.exe` and `chrome.dll` report version `158.0.8127.2`.

Authenticode checks returned **NotSigned** for both files. No signer validation
is claimed. Provenance relies on the official HTTPS object, its published
integrity metadata, and the frozen local archive/package hashes. The unsigned
status is included in comparison evidence and must be visible in its execution
decision. Downloading/extracting the package did not install or run it.

| Input | SHA-256 |
| --- | --- |
| Archive | `910b90200be540896e94ba1df9cf2ec4f106617f1fad8a4f56e21373437c6102` |
| chrome.exe | `e68951221347d128536cc08c2b72dbf4f65fa96a73eeefc3fb7ef3aa5d683610` |
| chrome.dll | `303835e293ab849a6c7443cc1ff893837e8740caee565a477db0923b3557c4be` |
| Sorted extracted-file manifest | `01cb8caecf3549b3903b0bb357bdbe7c8dd31a6c5d3541eac8436e3a25f03813` |

Preflight streams every extracted regular file into a sorted manifest of
relative paths and SHA-256 values, then checks its digest, count and byte total.
Links, redirected package roots, special entries, path traversal, excess depth,
excess entries and oversized content are refused. Archive and DLL hashes are
checked independently. No browser/profile storage is inspected.

### Frozen comparison procedure

The fixed `--compare-cft158` mode uses execution copies in
`.tmp/gate1-browser-comparison/`. Only the named comparison executable is added
to the launcher's allowlist. Launch flags, rejecting proxy, close semantics,
private observer, two-case order, budgets and cleanup are shared with the baseline.
There is no intervening navigation, delay or protocol request between HTTPS
rejection and close, and no retry or automatic baseline rerun.

One fresh `isolation-fixture-comparison-cft158-*` profile will be preserved there.
The exclusive future receipt is
`.tmp/gate1-checkout-enable-dd2c2c6/browser-page-lifecycle-comparison-cft158-01.json`.
Comparison mode checks all twelve predecessors before and after execution,
including the original Edge diagnostic. Existing comparison evidence refuses
another run. CLI executable/profile/output overrides remain unsupported.

The same limits apply: one launch, two simultaneous pages, two navigations,
five-second page operations, two one-second inventories, one cached version
read, 10 fixture requests, 100 proxy connections, 256 events and 128 KiB evidence.
Work ends by 70 seconds within a 90-second overall bound. Normal cleanup gets
the reserved time and never force-kills or deletes a profile. Both cases must
meet the original closure/target-absence/keeper criteria; failure stops later work.

The executed comparison's frozen four-file source-set SHA-256 is
`e7924e51b5abf43d4608e9d1ea5465bfe4abe5f3580b6da86d70dbc6f4662c67`.
The consumed command below used cleared `DEBUG`, `DEBUG_FILE`, `PWDEBUG` settings
for the child process and repository-local `.tmp` for `TEMP` and `TMP`. It is
historical execution documentation, not authorization to rerun. Its existing
receipt now prevents another invocation:

```powershell
node .tmp/gate1-browser-comparison/page-lifecycle-diagnostic.cjs --compare-cft158 --source-set-sha256=e7924e51b5abf43d4608e9d1ea5465bfe4abe5f3580b6da86d70dbc6f4662c67
```

Preparation passed 132 focused tests (79 isolation-helper and 53 diagnostic),
syntax checks, scoped ESLint with zero warnings, and whitespace checks. Read-only
comparison preflight passed against the actual package, execution sources and
twelve historical receipts without reserving output or loading Playwright.
Coverage adds executable selection with identical launch flags, exact package
provenance and tampering guards, separate exclusive output, baseline preservation,
the unchanged operation sequence, and the observed acknowledged-open timeout.

### Stopped comparison attempt

The single approved comparison started at `2026-11-01T18:01:53.391Z` and recorded
its result at `18:02:09.718Z`. It stopped in `setup/browser_startup` after 11,254 ms,
before either case, any navigation, or a live browser-version read. One launch,
zero fixture requests and zero proxy connections were recorded. The outcome is
`inconclusive`; it supplies no comparison evidence about page closure or the fix.

The preserved comparison receipt has SHA-256
`9be84f27995548b696e81cbfed62e2cabd29649028ff61865b5e56b3f3524ae8`.
It records `browser_cleanup`, `ownedBrowsersClosedNormally: false`, a preserved
synthetic profile and unchanged hashes for all twelve predecessors. Read-only
post-run inspection found the owned browser and runner still active. The fresh
synthetic profile's `DevToolsActivePort` file timestamp was `18:02:06.338Z`, after
the startup cutoff. The launcher had not obtained that port before cleanup.

The receipt's `elapsedMs: 16327` and `withinOverallLimit: true` describe its
recorded work through finalization, not successful termination of owned processes.
Process lifetime was not bounded by that receipt field. The executed source set
had a startup/cleanup limitation; that attempt was not a cleanly completed bounded
exercise.

The current helper retains the owned profile path and launch timestamp so cleanup
can discover a freshly written `DevToolsActivePort` after startup times out. Port
reads, attachment, normal `Browser.close`, and process-exit checks share the existing
five-second no-port cleanup window. The ten-second startup timeout remains the
primary failure. If the process remains running, absent/stale/invalid ports or an
unsuccessful shutdown still report cleanup failure without extending that window.
Mocked regression tests cover this follow-up; the historical execution copies,
source-set hash, receipt and profile are unchanged, and no native comparison was
rerun.

A separate 20-second normal-shutdown recovery was proposed, using the owned
process and its fresh DevTools endpoint, with no test retry, new launch or
force-kill. It has not been authorized or performed. The proposed separate
receipt is `browser-page-lifecycle-comparison-cft158-01-recovery.json` in the same
local evidence directory. Preserve the original receipt and profile; publication
does not authorize recovery or further native work. Operational receipts, browser
packages and profiles remain local and are not included in this PR.

The browser product and version both change, so a `not_reproduced` outcome cannot
prove causality for one upstream fix or qualify installed Edge. Either outcome
returns to a decision. No full isolation fixture, worker/restart exercise, hosted
CSRF retry or toolchain substitution follows automatically. GATE-1 stays open.

### Executed comparison 02 (2026-11-01)

The owner approved local preparation and offline validation for a second comparison.
A separate approval then authorized one native execution with the exact source digest
and scope below. Preparation started from staging `a61650fa6871a6d2f53b324cb9f4a91e4f300559`,
which includes the late-port cleanup correction from PR #322. The isolation helper
and its tests are unchanged. The cleanup correction does not extend the ten-second
startup deadline or establish that another launch will reach either case.

The new fixed `--compare-cft158-02` mode binds the existing `cft158` executable
allowlist entry to these distinct destinations:

- Execution copies: `.tmp/gate1-browser-comparison-cft158-02/`.
- Fresh synthetic profile prefix: `isolation-fixture-comparison-cft158-02-`.
- Exclusive receipt:
  `.tmp/gate1-checkout-enable-dd2c2c6/browser-page-lifecycle-comparison-cft158-02.json`.

It checks thirteen predecessors before and after execution: the original eleven,
the Edge diagnostic, and the stopped Chrome comparison. The latter remains pinned
to `9be84f27995548b696e81cbfed62e2cabd29649028ff61865b5e56b3f3524ae8`.
The earlier modes retain their original receipt paths and histories; their occupied
destinations cannot be reused. No CLI target, executable, profile, output, deadline
or attempt-number override is accepted. The new mode records `mode: cft158-02`.

The operator was the Codex agent and the operational/risk owner is the
project owner. The target remains the exact Chrome for Testing 158.0.8127.2 package
and Node/Playwright pins documented above. Complete package verification and both
unsigned-binary limitations apply to this mode too. No new download, installed
browser change, Edge baseline rerun or launch-flag change is included.

The approved cases were blank-page close, followed only on success by HTTP and
HTTPS CONNECT rejection and immediate page close. Each must meet the existing
command acknowledgment, root detachment, server/client closure, promise settlement,
target absence and keeper-readiness criteria. The existing limits remain:

- One launch, at most two simultaneous pages and two disposable pages created.
- Two scripted navigations, two one-second inventories and one cached version read.
- Ten-second startup port wait and five-second page operations.
- 10 fixture requests, 100 proxy connections, 256 events and 128 KiB evidence.
- A 70-second work deadline inside the 90-second exercise budget, with 20 seconds
  reserved for cleanup and evidence. Late-port discovery, attachment, normal close
  and exit verification share the existing five-second no-port cleanup window.

Both cases, cleanup, profile preservation and all thirteen history checks must
complete within their budgets for `not_reproduced`. Startup failure, missing
observations, timeout, overflow, integrity drift or cleanup failure is inconclusive
and stops further work. Normal cleanup preserves the synthetic profile. If an owned
process remains, report the cleanup failure and return to the owner; elapsed receipt
time alone is not proof of process termination. No force-kill, automatic retry or
recovery operation is authorized by this preparation.

The frozen four-file source-set SHA-256 is
`97b3b8854b14e177c9417888836ed5e4dca2f57143bde87758d0b06665357edb`.
Execution copies match the preparation worktree byte-for-byte:

| Input | SHA-256 |
| --- | --- |
| request-client-isolation.cjs | `58eee4749d1f14ca196437b4748f03be0e9af9602c2b229d79016874a31ba462` |
| __tests__/request-client-isolation.test.cjs | `d4578324a5e5926b733672a0dd9889ca6bb94445667adc537c2b8191ef1cc2bf` |
| page-lifecycle-diagnostic.cjs | `7a58852bb78a6255edf44d8c5934998b50e0f07d512186ef40508e81c3a971bc` |
| __tests__/page-lifecycle-diagnostic.test.cjs | `539344722b7a17139d3e382db26f40ae994b8c6a6301bd6a56173341d37add2b` |

Preparation passed 159 focused tests, four CJS syntax checks, scoped ESLint with
zero warnings, and whitespace checks. Read-only execution-copy preflight verified
the pinned runtime/bundle/executable, archive, all 305 package files and thirteen
predecessors. It did not load Playwright, reserve the receipt or create a profile.
The receipt was absent before the approved run. Coverage includes immutable mode selection, package/source/
history failures before reservation, occupied-output refusal before native setup,
the unchanged two-case sequence, and late-port cleanup preserving startup failure.

The following command was executed once under the separate approval. `DEBUG`,
`DEBUG_FILE` and `PWDEBUG` were cleared only in that child process; `TEMP` and `TMP`
used repo-local `.tmp`. Input bytes, predecessor hashes, process ownership and the
absent receipt were rechecked immediately before execution. This command is
historical documentation, not authorization to rerun; its occupied receipt refuses
another invocation.

```powershell
node .tmp/gate1-browser-comparison-cft158-02/page-lifecycle-diagnostic.cjs --compare-cft158-02 --source-set-sha256=97b3b8854b14e177c9417888836ed5e4dca2f57143bde87758d0b06665357edb
```

Pre-execution reconciliation on November 1 found no matching comparison Chrome process
or Node runner, and no recovery receipt. The prior cleanup failure remains historical
evidence; the shutdown mechanism is unknown. All thirteen receipts and both historical
execution source sets matched their frozen hashes during preparation.

The approved run started at `2026-11-01T23:45:28.871Z` and completed at
`23:45:33.664Z`, recording 4,793 ms and `phase: not_reproduced`, with no first
failure or cleanup failure. Both HTTP and HTTPS CONNECT rejection checks passed.
Both close commands were acknowledged, with root detachment, server/client closure,
promise resolution, target absence and sole-keeper readiness observed before their
five-second deadlines:

| Case | Close completion/cutoff | Target absence confirmed |
| --- | --- | --- |
| Blank page | 12 ms | 13 ms |
| After rejected HTTP/HTTPS navigation | 515 ms | 517 ms |

Counts were one launch, zero fixture requests, 18 proxy connections, two scripted
navigations, two target inventories, one cached version read and two disposable
pages created. Normal browser cleanup succeeded and the synthetic profile was
preserved. Independent post-run inspection found zero matching comparison Chrome
processes or Node runners. All thirteen predecessor receipts, the frozen source set
and the pinned package remained unchanged. Startup completed normally, so this run
did not exercise the late-port recovery path covered by the mocked regressions.

The retained comparison-02 receipt has SHA-256
`96eb4d6d7df5cb895aa1833958fc7dd3d90f8c1095aee6030b7801d383f0983a`.
The receipt, package and synthetic profiles remain local and are not committed.
The earlier Edge close failure and first comparison's startup/cleanup failure
retain their original meaning; this result does not relabel them as passes.

This comparison cannot qualify installed Edge, attribute causality to a single
Chromium fix, or qualify restored-worker isolation. GATE-1 remains open. Full local
isolation qualification and any subsequent hosted CSRF exercise require their own
bounded proposals and approvals; neither follows automatically from this comparison.

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
