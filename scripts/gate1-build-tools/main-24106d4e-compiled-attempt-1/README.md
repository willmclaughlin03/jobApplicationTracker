# Exact-main compiled middleware qualification: consumed attempt

## Publication status

This tracked package preserves the reviewed local qualification tooling and its
stopped attempt. Its CLI now rejects `--prepare`, `--execute` and `--inside` with
`reservation` before doing work, even in a clone with no local evidence. The
historical commands below document the consumed contract; they are not runnable
instructions or renewed authorization. Imports remain available for offline tests.

The approved original package digest was
`9db5cff977c47a4d94f360930035f204ed9e39ee1db0ae9484e45e31ad44ee50`.
Docker Desktop started, the offline image was assembled, and the attempt stopped
with `failure: source` at `step: prepare`. No dependency installation, application
build or loopback request ran. The report records `requests: 0` and
`containerStopped: true`. The exact source-validation subguard remains unknown;
this is not an established application compatibility failure or a corrected cause.
The existing successful exact-main CI result below remains separate evidence.

Original package and execution records remain frozen in the primary workspace at
`.tmp/gate1-build-tools/main-24106d4e-compiled-attempt-1/` and
`.tmp/gate1-build/main-24106d4e-compiled-attempt-1/`. They are not bundled in this
PR. The saved report SHA-256 is
`a9e80b6934e37308b1e7a6e1bad4bcca6e4e27a2fae35f23f3b5d1e32ac2d220`.
Publication changes this README, the CLI refusal and its tests; the consumed
digest does not authorize the published bytes. No new attempt is selected.

Publication validation: 81 offline tests across two suites, four syntax checks and
focused repository-config ESLint passed. The three new CLI cases assert refusal
before filesystem evidence checks, writes or child spawning. These mocked checks
do not repeat the consumed install/build/runtime exercise.

The next decision is whether to approve a bounded read-only comparison of the
frozen source manifest against existing extracted files, retaining only permitted
mismatch facts. Do not replay, rebuild, change the source guard or broaden the
diagnostic automatically. Gate 1 stays open and Gate 5A stays unpassed.

## Historical preparation and execution contract

Gate 1 remains open; Gate 5A remains unpassed. This package does not identify a
deployment, configure the hosted probe, observe hosted execution, qualify secret
snapshots or perform rollback. The owner approved creation of these six files and
the detached worktree. Installation, image assembly, build and loopback execution
require a separate review and approval of the finished digest.

## Reconciled evidence

Selected main: `24106d4e49fc26d5aabac99660f33ea89829d9c5`.
Source tree: `00f6172d8b60b75b530c2c0e936672bcea1c37c6`.
Committed lockfile SHA-256:
`f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a`.

Main push CI run 43790832789 checked out that exact commit and succeeded under
Node 22.23.4, npm 10.9.9 and Next.js 16.3.3. It reported 145 passing suites,
5,578 passing tests and 364 skipped tests, plus lint, build, protected-page artifact
and Sharp checks. Both PR CI merge trees also equal this source tree. No downloadable
artifacts were available. Reuse that CI evidence within this scope; do not repeat
the broad application suite merely to reconstruct compiled middleware evidence.

Read AGENTS.md and both Gate 1 amendments with the historical plan in the primary
checkout. The plan SHA-256 remains
`4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f`.
Source/WAF deferrals do not waive Node 22, application cache/cookies, secrets,
application load/logging or immutable rollback. The artifact privacy scanner is
closed as inconclusive and is not invoked by this package.

## Inputs and write boundaries

All host paths are beneath `C:\Users\willm\job-application-tracker`:

- Detached source: `.tmp/worktrees/gate1-main-24106d4e-compiled`.
- Package: `.tmp/gate1-build-tools/main-24106d4e-compiled-attempt-1`.
- Preserved read-only archives: `.tmp/gate1-qualification-inputs-7f70e4eb`.
- Exclusive future destination: `.tmp/gate1-build/main-24106d4e-compiled-attempt-1`.

The future destination contains only the generated `profile.json`, exclusive
`reservation.json`, sanitized `report.json`, `context/` and `state/` trees. Context
contains the two copied archives, committed source tar, two runner files,
Dockerfile, contract and Docker image ID file. State contains the source copy,
`node_modules`, `.next`, npm cache, temporary/home directories and empty npmrc
files. Neither source worktree nor the primary checkout is used for build output.
No `.env` file, provider snapshot, credential store or old reservation is read.

Node archive SHA-256:
`1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af`.
Npm cache archive SHA-256:
`041659a5d51213b62dbb2bd7a74770ec8cf0ec1116ea0a1e7401eaf2c92163d1`.
Both matched during reconciliation; the acquisition inventory covered the current
Linux/x64 lockfile dependencies. Installation still independently verifies npm's
cached package integrity and must stop on missing/unusable offline content.

The local runtime is Node 22.23.3, npm 10.9.9, Next 16.3.3, React/React DOM 18.3.1,
and Acorn 8.15.0. Node's patch differs from CI; this is explicitly local evidence.
The controller also requires Node 22 and binds its exact version into the digest.

The cached Linux/amd64 base is pinned to Amazon Linux digest
`sha256:500790b3c980438d9d6cde6c149e59dda1992660941a814198b95ed56574fb96`.
Docker Desktop's `desktop-linux` engine must already be running and the base image
must already exist. The package never starts Desktop, pulls an image, downloads a
package, refreshes credentials or makes a provider request. Docker stores the new
image and stopped container in its existing engine storage; these are additional
explicit execution side effects. Existing images, volumes and containers are not
deleted or reused as writable state.

## Read-only preparation and offline checks

```powershell
$repo = 'C:\Users\willm\job-application-tracker'
$env:TEMP = Join-Path $repo '.tmp'
$env:TMP = $env:TEMP
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$package = Join-Path $repo '.tmp/gate1-build-tools/main-24106d4e-compiled-attempt-1'
node (Join-Path $package 'qualify-build.cjs') --prepare
```

Preparation checks the clean detached checkout, commit/tree/lockfile, six package
files, source archive, source page inventory and both archives. It prints the
approval digest without writing files or contacting Docker. It cannot reuse an
existing evidence destination. Git reads may require normal sandbox escalation.
The sanitized Git environment explicitly preserves this checkout's `autocrlf=true`
and `filemode=false` interpretation. Source/archive/lock hashes bind committed bytes,
not CRLF working-copy encodings; no working-copy normalization is performed.

Run the two CJS Jest suites with this package as rootDir, Node environment,
`**/__tests__/*.test.cjs`, no transforms, `js/cjs/json` extensions, primary
`node_modules` for Jest/Acorn only, inBand and no cache. Run four `node --check`
commands, focused ESLint, whitespace and preservation checks. Tests are synthetic
and mocked; they do not install dependencies, invoke Docker or send HTTP requests.
Shared Next 16.2.12 is never used as build evidence.

## Separately approved execution

Only after reviewing and approving the exact printed digest:

```powershell
node (Join-Path $package 'qualify-build.cjs') --execute <approved-digest>
```

One attempt, 30 minutes total, including image assembly. The independent container
timeout is set to the host's remaining budget. Cleanup alone may use bounded
30-second Docker commands after that deadline. Resource controls: 4 CPUs, 6 GiB
memory with no additional swap, 256 processes, read-only container root, UID 1000,
all capabilities dropped, no-new-privileges, no restart, no Docker log retention,
no published ports, and `--network=none`. Only the fresh repo-local state directory
is mounted writable. Configuration is inspected before the container starts.

The 8 GiB/250,000-entry workspace ceiling is monitored, not a filesystem quota;
short polling overshoot is possible. It excludes Docker's own image storage.
Source/archive and child-stream caps are separate. Raw process streams are discarded.

The synthetic build inputs match the CI names and use only `.invalid` endpoints
and synthetic values. The local probe has a synthetic dedicated key, distinct from
every hosted credential. No inherited application environment is passed through.

Commands inside the disconnected container:

1. `npm ci --offline --ignore-scripts --no-audit --no-fund --include=dev`.
2. Verify the exact installed versions and unchanged lockfile.
3. `npm run postinstall --offline` (root `patch-package` only).
4. `npm run build` (existing preflight, then Next production build).
5. Inspect the actual Node middleware output and manifests.
6. One local production-server smoke sequence, then close it.

Dependency lifecycle scripts stay disabled, including unrs-resolver's install hook.
The Darwin-only fsevents hook does not run. This differs from ordinary CI's lifecycle
execution and is recorded, not hidden. If a required native dependency cannot work
under this exact scope, stop without a network or lifecycle fallback.

## Compiled-reader and local-smoke acceptance

The inspector supports a Node entry declared as `/_middleware` in
`server/functions-config-manifest.json`, `server/middleware.js` with its NFT trace,
and the corresponding middleware/pages/routes/build manifests. This is an explicit
supported output contract, not an assumption that Node uses the old Edge entry.
An unsupported or incomplete output shape stops as a method limitation.

Trace files must stay inside the application; links/escapes are rejected. Inspection
is limited to 1,024 emitted server JavaScript files, 16 MiB each and 128 MiB total.
Acorn must find exactly one structural three-field native-reader candidate in this
declared closure. Constants, marker strings, differing base expressions and ambiguous
multiple readers are insufficient. The original matcher and source page inventory
must remain represented. This is not a comprehensive artifact-privacy scan or a
local/deployed manifest comparison.

For local execution only, the harness temporarily wraps `process.version`,
`process.versions.node` and `process.release.name` getters without changing their
values. It counts reads only when the immediate caller is inside the exact AST span
of the compiled reader. Native descriptors are restored in cleanup. This synthetic
instrumented local server is not hosted evidence. Unsupported stack/compile behavior
is inconclusive, never inferred from a marker or matching version constant.

Six sequential loopback GETs, no readiness HTTP requests or redirects:

1. Ordinary `/login`.
2. Authenticated `/login` with fresh challenge A.
3. Authenticated `/login` with fresh challenge B.
4. `/login` with the wrong synthetic credential.
5. `/login?scope=1` with diagnostic headers, outside observer scope.
6. Anonymous `/admin` with diagnostic headers; it must still redirect to local login.

The server binds `127.0.0.1:32147` inside the network-disabled container. No browser
scripts run and no Supabase/Redis/Stripe/Axiom service is reachable. Each exchange
has a 10-second deadline, 1 MiB body and 16 KiB header cap, no pooling/retry/redirect.
No cookies are sent. Response bodies and header values are transient and discarded.

Positive observations require exactly one response observation header, strict schema,
fresh challenge agreement, Node 22.23.3, independently checked major/boolean agreement,
exactly one native read per field, HTTP 200 and effective private/no-store policy.
Every case rejects Set-Cookie. Negative cases must disclose nothing and perform no
counted native read. The protected case must retain its login redirect/no-store policy.
These anonymous cases do not qualify real refresh cookies, cross-profile isolation,
all routes or hosted cache behavior. Those obligations remain separate.

## Stop and retention policy

The reservation is consumed on partial creation, failure, cancellation or success.
Never retry, overwrite, delete the destination or replay the attempt. Missing engine,
base image or existing container stops at preflight without installation. Source or
toolchain drift, build failure, unsupported output, non-22 observation, absent/malformed
evidence, cache/cookie failure, cap/deadline failure or incomplete cleanup stops the run.
Return the precise category, step and Gate 1 consequence; do not expand diagnostics.

Evidence retains only the approved source/toolchain IDs, package/source/artifact hashes,
counts, fixed failure categories and validated policy/runtime facts. It excludes raw
logs, response headers/bodies, cookies, challenges and credentials. Normal synthetic
build artifacts remain in the exclusive state tree; no complete privacy claim follows.

`complete_local_only` establishes this bounded compiled-middleware/local smoke result.
It cannot override historical Node 24 provider metadata, qualify the current hosted
target, establish secret/HMAC compatibility or pass Gate 1. Next, separately propose
hosted probe readiness/configuration, choose the final deployment, identify it with
a fresh approved package, then seek exact-digest approval for attributable runtime
observations. Preserve the original firm stop, source/WAF deferrals, closed scanner,
remaining non-deferred evidence and immutable A/B/A prerequisites.
