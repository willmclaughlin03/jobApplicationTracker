# GATE-1 browser tab runner

This helper prepares the 1/2/4/8-tab browser qualification and provides offline
checks. Publishing it does not run or approve hosted traffic. GATE-1 remains open;
the scanner investigation remains closed as inconclusive and WAF source attribution
is still unqualified. No application routes, WAF rules or deployment settings change.

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

The recorded target is commit `ce7ac0977fc538940e2acb339195cf2874c96aee`, build
`NEMMu5_HCxJLWxeA7FEQD`, on these origins:

- Canonical: `https://job-application-tracker-kappa-seven.vercel.app`
- Generated: `https://job-application-tracker-e9yeig5hf-track-the-app.vercel.app`

The [Vercel deployment reference](https://vercel.com/track-the-app/job-application-tracker/FXkGQcSq6SWw1xcaw3DhhvvSywbf)
and GitHub deployment `7257610199` identify the recorded target. Its actual Vercel
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
The October 22 ledger before any continuation records 74 application / 74 static /
26 session actual requests, or 75 / 74 / 26 conservatively including one historical
reserved-but-unsent application request. Manual owner sign-in traffic is separate.
One new preparation session plus the remaining profile caps would permit cumulative
maxima of 975 / 1,194 / 363 actual, or 976 / 1,194 / 363 including that reservation.
This fits the existing limits with only one additional session request of headroom.
A full rerun plus that preparation would permit 1,055 / 1,274 / 387 actual requests
and exceeds the application and session limits. Reconcile any subsequent traffic
and target changes before separately approving a continuation; this calculation
does not authorize preparation or execution.

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
retaining its raw error, URL, account data or browser state. Recognized qualification
errors and the budget's first stop reason retain precedence; cleanup still closes
only owned test pages.

Operation codes do not establish an underlying application or browser cause, and
cannot retrospectively attribute an earlier `tool_failure`. The frozen profile,
timing and request limits remain unchanged. A stopped hosted exercise requires a
new decision and authorization before another attempt.

On the recorded target, the October 22 hosted exercise passed the 1-tab profile
and stopped during 2-tab startup with `visibility_visible_wait_failed`; 4/8 tabs
were not executed. Local simulation reproduced a missed observation when animation
frames were withheld, but does not establish that as the hosted failure's cause.
The timer-polling fix passed unit tests and the native loopback fixture; no hosted
retry has validated it. The remaining-profile mode passed local selection, rejection,
first-failure and owned-cleanup tests as part of the 60-test offline suite. No hosted
continuation has run. Browser preparation and a new bounded exercise still require
their applicable approvals; the prior 1-tab pass remains separately attributed to
its original target and run. GATE-1 remains open.
