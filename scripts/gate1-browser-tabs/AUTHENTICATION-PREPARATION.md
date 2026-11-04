# Authentication preparation: offline controls and qualification

This seven-file addition implements the approved offline scope after anonymous
build attribution. Gate 1 remains open. It does not enable live authentication.
The application, eleven previously reviewed files, original README, consumed
build attempt and accepted isolation receipts are unchanged.

The staging checkout converted only `hosted-csrf-build-attribution.cjs` and its
test from LF to CRLF. Source binding verifies the consumed eleven-file hash,
requires identical content after that specific two-file line-ending conversion,
and includes both raw dependency maps in the new source-set hash. It does not
rewrite either dependency or substitute new bytes into historical receipts.

## Coverage decision

The pinned Playwright protocol describes `Target.setAutoAttach` in terms of
related targets, including iframes and workers. Page `Network`/`Fetch` events do
not establish complete browser-background coverage. A CONNECT proxy can constrain
destinations, connection counts and encrypted bytes, but cannot count HTTP requests
inside TLS. A passing page-event comparison therefore retains
`browserTrafficMeasured: false`. No complete coverage mechanism is implemented.

`--execute-reviewed-manifest` fails with `coverage_unqualified` before reading a
manifest or performing any I/O. `finalizeAuthentication()` also always rejects.
There is no force flag or native live adapter. The future plan validator records
the proposed contract without granting execution. Offline evidence cannot satisfy
the existing diagnostic's `validatePreparation` contract.

## Approved local qualification

Operator: Codex agent. Operational/risk owner: project owner.
One attempt, at most 180 seconds including cleanup and postflight, two launches,
one new synthetic profile. The first 150 seconds are available for work. Browser
closure uses the same overall clock, reserving the last 15 seconds for postflight.
No automatic repeat or extra case follows a stopped or inconclusive native run.

The worker:

1. Verifies the original eleven-file source binding, all fifteen history hashes,
   build/manifest hashes, the seven added files and the pinned browser package.
2. Starts two loopback listeners. The proxy rejects CONNECT and all external
   destinations; no hosted application or OAuth request is forwarded.
3. Launches pinned Chrome with the synthetic profile and no proxy bypass.
4. Attaches CDP Fetch/Network before opening the forwarding gate or navigating.
5. Reserves the synthetic `/start` redirect and `/login` hop independently,
   establishes a persistent synthetic cookie, and verifies a synthetic identity.
6. Closes Chrome normally and independently checks executable/profile processes
   and its CDP listener through PowerShell and a loopback port probe.
7. Restarts the same profile behind the rejecting proxy and makes exactly one
   context-bound `/session` request to verify persistence. The request client
   bypass is explicit, separately reserved and restricted to the loopback origin.
8. Demonstrates a different-host synthetic navigation blocked before forwarding.
9. Closes normally, preserves the profile, closes local listeners and writes a
   preliminary attempt exclusively.

The supervising process requires the worker's exit code zero and finalized
completion with the exact attempt hash. It rechecks sources, process absence and
all listeners before exclusively writing a scoped offline postflight receipt.
Missing permissions, truncated output, nonzero exit, failed writes, extra evidence
fields, unmatched page events or uncertain closure cannot become a pass.

Artifacts are fixed and single-use:

```text
.tmp/gate1-authentication-preparation-offline-01/
  worker-started
  synthetic-profile/
  attempt.json
  postflight.json
```

No authenticated profile or `authentication-preparation.json` is created. No
browser storage is inspected; only `DevToolsActivePort` is read for attachment.
No screenshot, HAR, raw protocol data, request URL, header/body, cookie value,
account identifier or identity hash is retained in evidence. The fixed synthetic
fixture identity/cookie are non-secret test data. Browser-generated synthetic
profile files are preserved, not inspected or exported.

Offline budgets: application 12, session 4 (included), zero provider/static/
metadata requests, 128 proxy connections, 16 concurrent, two pages per browser,
1,024 page-observation events, 16 KiB evidence. The proxy bounds cumulative HTTP
request body bytes at 64 MiB, including denied requests; headers, HTTP framing and
rejected CONNECT traffic are excluded. Tiny fixed loopback responses are
separately bounded by fixture count.
Native launch/CIM/CDP operations are bounded. Browser-background attempts rejected
by the proxy are summarized as connections/denials, not fabricated HTTP counts.
This does not prove OS-wide egress isolation, UDP/WebRTC isolation, whole-process
memory bounds or complete background request measurement. Post-buffer response
checks are not streaming memory limits. Retain the Chrome EXE/DLL NotSigned
disclosure from the accepted package provenance.

## Commands

Use Node 22.18.0 and main-checkout dependencies through `NODE_PATH` in the isolated
worktree. Set `TEMP` and `TMP` to the main checkout's `.tmp`. Clear `DEBUG`,
`DEBUG_FILE`, `PWDEBUG`, `NODE_OPTIONS`, and `NODE_DEBUG` in the child environment.

```powershell
node --test scripts/gate1-browser-tabs/__tests__/authentication-preparation.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-traffic.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-postflight.test.cjs
node scripts/gate1-browser-tabs/authentication-preparation.cjs --source-hash
node scripts/gate1-browser-tabs/authentication-preparation.cjs --qualify-loopback <reviewed-source-set>
```

The last command consumes the separately approved single native attempt. Unit
tests use mocks, do not launch Chrome and do not create the attempt directory.
Syntax, scoped ESLint and whitespace checks precede the native run. After changing
code, do not describe an earlier source-bound native receipt as validation of the
changed source. Preserve the attempt and return to the owner if a repeat is needed.

## Future live preparation contract (unapproved and not executable)

Frozen attribution: deployment `dpl_jbyKAs8vNoVbGQ4vSM5hKd7LSrTJ`, source
`62b4133d257b43529d93e62f98afc8ccb2faf15b`, build `YB6TC2dgLcUGcHUpFCAaM`.
Canonical `job-application-tracker-kappa-seven.vercel.app`. Future execution must
recheck exact project/alias/deployment metadata before and after; current Git refs
alone do not prove deployment identity. Preserve successful build invocation and
`receiptFinalized:true` observations as well as its on-disk receipt.

Draft destinations, HTTPS/443 only, no wildcards:

- Canonical GET `/`, `/login`, `/auth/callback`, `/api/auth/session`,
  `/api/auth/csrf`, `/api`; static `/_next/static/` and `/favicon.png`.
- Supabase `apxfjggdcybjticrnbpk.supabase.co`: GET `/auth/v1/authorize` and
  `/auth/v1/callback`, during OAuth only.
- Google `accounts.google.com`: GET/POST during owner-operated OAuth only.
- Candidate GET-only support hosts `www.gstatic.com`, `ssl.gstatic.com`,
  `fonts.gstatic.com`, `fonts.googleapis.com`, `lh3.googleusercontent.com`.
  This is a proposed allowance, not an observed complete provider inventory.
- Metadata uses only the existing guarded `api.vercel.com` project/alias/deployment
  commands. It is never an allowed browser destination.

Unknown destinations or provider refusal stop; no bypass, allowlist expansion,
automatic sign-in retry, refresh, profile migration or account-management action.
OAuth server-to-server exchanges are outside the browser measurement boundary.
Application retry/focus behavior must be blocked after the first failure.

Draft live limits remain 900 seconds including 60 cleanup/postflight, 600 manual
sign-in seconds, two launches, one OAuth attempt, two pages, application 24,
session 8 included, canonical static 80, provider static 120, Supabase 4, Google
non-static 96, metadata 6 at 30 seconds each. Browser HTTP operations 30 seconds,
restart session 5 seconds; proxy request body bytes 64 MiB, connections 128 total/16
concurrent; receipt 16 KiB. Every redirect and uncertain dispatch stays charged.
These limits are validated as proposed values, not implemented live coverage.

Current application/static/session ledger (build already included): actual
150/150/52, conservative 151/150/52. Draft maximum after preparation: 174/350/60
and 175/350/60, respectively. These are ceilings, never executed totals. Provider
non-static and metadata counters remain separate. Historical background traffic
is still unmeasured. Offline loopback counts do not increment hosted ledgers.

Expected UUID must be supplied privately as `GATE1_APPROVED_USER_ID` before a
future live attempt. Never request it in chat, read `.env`, or derive it from the
session under test. Comparison occurs in memory before/after restart. The final
live receipt would require exact target/build/profile, measured incremental
counts, identity verification, full browser traffic measurement, normal closure
and independently established process exit. No synthetic receipt substitutes.

## Next decision

Review this bounded offline result and resolve the specific complete-traffic
coverage gap with the owner. This code does not implement an unreviewed TLS
interceptor, OS firewall change or weakened receipt contract. Any selected
measurement correction or explicit amendment needs a concrete scope before code
or execution. Only then prepare the separate live authentication proposal, followed
by separate hosted CSRF approval if preparation succeeds. Neither result closes
Gate 1 or authorizes checkout, load, rollback or provider changes.
