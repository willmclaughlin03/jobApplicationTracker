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
separate explicit authorization, the complete `[1, 2, 4, 8]` profile list, an
owner-approved test identity and an exclusively prepared browser context with exactly
one blank page and no service workers. The approval marker is a caller assertion,
not a substitute for that authorization. Account preparation and authentication are
outside this helper. Never supply a personal browser context.

The frozen target is deployment `dpl_B7x6hUkkdoXpMCWVaMfxbGZgLiJo`, commit
`3e33fea683271a5232bc93e1eedac29826ed31e9`, build `h3VsmNyDZ322h7VCK7Gqs`.
Credentialless canonical and immutable host probes compare that build before and
after each profile. A changed or cached probe stops qualification; these constants
are not a claim that the current staging branch matches the deployed target.

The proposed whole-run limits are 55 minutes, 1,000 application requests, 1,280
static requests and 364 session requests, including readiness allowances. These
limits need their own hosted approval and do not override an earlier traffic ceiling.
Per-profile limits and rolling 61-second caps reserve requests synchronously before
dispatch. HTTP errors, unexpected origins/methods/redirects, identity mismatches,
child targets, timeouts or exhausted limits stop the run.

Session latency includes full-response completion. CSRF latency ends at response
headers because the application leaves that body unread; the runner never reads the
CSRF token. Reports label both boundaries separately and apply the proposed 2-second
p95 / 5-second maximum to each. HTTP cache is disabled. Identity comparisons stay
in memory and reports retain only booleans, fixed categories, counts and timings;
they do not export session bodies, cookies, headers or account identifiers.

Passing local checks does not establish hosted identity isolation, WAF attribution,
provider capacity, deployment qualification or release approval.
