# Gate 1 source archive byte preservation

## Publication status

This tracked package publishes the prepared attempt-2 candidate and its archive
regressions. Checkout validation retains its Windows CRLF policy; archive generation
uses separate settings and must match every selected committed Git blob before a
digest is returned or Docker assembly can begin.

The original local package at
`.tmp/gate1-build-tools/main-24106d4e-compiled-attempt-2/` remains unchanged. Its
read-only preparation verified all 362 files, 432 entries including metadata and
4,733,007 payload bytes. Its source archive SHA-256 was
`f331f1b02cbda25a140ff1ddf17c7b192d2a7dadcd8de9cba0bc419acf38303b`,
and its prepared digest was
`387dbca8ef639a8c738733f10e7b419e17d3bbbd13deb09ff2c7849fe833444d`.
That digest is a recorded local preparation result, not execution approval.

The publication copy resolves the installed standalone TAR reader through Node's
module lookup, including the documented `NODE_PATH` linked-worktree setup, and
still requires an approved exact hash before loading it. The supported host-reader
pins, portability change and publication paths change the candidate's bytes/contract. The recorded local
digest cannot authorize this copy; any execution requires review of a freshly
prepared exact digest and separate approval. No package installation, Docker read
or start, application build, application request or hosted qualification occurred
during publication. The consumed attempt-1 and all local evidence remain excluded.

## Local preparation contract

Gate 1 remains open; Gate 5A remains unpassed. This package does not identify a
deployment, configure the hosted probe, observe hosted execution, qualify secret
snapshots or perform rollback. The owner approved focused local package preparation and offline checks.
This fresh package contains eight files; preparation requires the detached source
worktree and preserved archives at the paths below. Installation, image assembly, build and loopback execution
require a separate review and approval of the finished digest.

## Focused packaging correction

The consumed attempt-1 and its records remain frozen. The approved bounded read
validated its saved archive and contract, found all 362 expected regular files,
and found exact Git blob mismatches in 360 files. It used no Docker reads. This
established an archive/manifest mismatch before application execution; the first
historical failing file and extracted container bytes were not observed.

This fresh package separates archive creation from checkout validation. It uses
`source-archive.cjs` for a complete in-memory preflight before returning a digest
or allowing Docker assembly. Missing, extra, duplicate, linked, unsafe, malformed
or content-mismatched entries fail with fixed sanitized categories. The original
in-container exact source verification remains unchanged.

Host preparation supports the standalone bundle at
`node_modules/next/dist/compiled/tar/index.min.js` from either supported installation:

| Host Next version | Approved reader SHA-256 |
| --- | --- |
| 16.2.12 (existing shared host) | `7f02d0edb684eafcc2bef85c66b3ab6083c26adfc5b583a6726a910cffa2c603` |
| 16.3.3 (locked application and CI installation) | `afc929b535e65468c4891a31b2243f3e6a24874707135b8e183ddc4e7cabba77` |

The 16.3.3 reader matches the preserved npm package after checking that package's
integrity against `package-lock.json`. The actual reader bytes must match one of
these exact hashes before loading. Both the supported digest map and the digest
actually used are bound into the approval contract; archive verification reports
the actual digest. Unrecognized bytes still fail with `archive_parser`.

The repository manifest and lockfile remain pinned to Next 16.3.3, matching the
selected application's offline build inputs. Supporting the older shared host
does not change that build version. No parser is downloaded, copied into the
container, or used as Next application-build evidence.

The preflight uses the existing reader without extraction or link traversal. It
accepts only uncompressed TAR, caps archive/payload at 128 MiB, expected files at
4,096, entries including metadata at 8,192, each metadata entry at 256 KiB, and
parsing at 30 seconds. Output contains fixed categories and aggregate counts, no
file contents, arbitrary member names, parser messages or stack traces.

A successful preparation is archive agreement only. No installation, Docker
startup/assembly, application build, loopback request or hosted action is approved
by this local preparation. A new execution requires separate exact-digest approval.
If this focused correction cannot establish exact agreement, stop and return for
an evidence-method decision; do not extend the investigation automatically.

Original local validation: 99 tests across three suites, six syntax checks and focused
repository-config ESLint passed. The real Git fixture reproduced content drift
under `autocrlf=true`; archive-specific settings preserved both committed text and
binary bytes. The read-only preparation output records the selected source's actual
archive agreement and finished digest separately. These checks do not qualify a
compiled artifact, container execution or hosted runtime.

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

All host paths are relative to the checkout containing this tracked package:

- Detached source: `.tmp/worktrees/gate1-main-24106d4e-compiled`.
- Package: `scripts/gate1-build-tools/main-24106d4e-compiled-attempt-2`.
- Preserved read-only archives: `.tmp/gate1-qualification-inputs-7f70e4eb`.
- Exclusive future destination: `.tmp/gate1-build/main-24106d4e-compiled-attempt-2`.

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
$repo = (git rev-parse --show-toplevel).Trim()
$env:TEMP = Join-Path $repo '.tmp'
$env:TMP = $env:TEMP
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$package = Join-Path $repo 'scripts/gate1-build-tools/main-24106d4e-compiled-attempt-2'
node (Join-Path $package 'qualify-build.cjs') --prepare
```

Preparation checks the clean detached checkout, commit/tree/lockfile, eight package
files, all 362 archived source blobs, source page inventory and both offline input archives. It prints the
approval digest without writing files or contacting Docker. It cannot reuse an
existing evidence destination. Git reads may require normal sandbox escalation.
Checkout validation retains `autocrlf=true` and `filemode=false`. Archive creation
overrides `core.autocrlf=false` and `core.eol=lf` for that Git command only. The archive
must then match every selected committed blob exactly; no normalization is accepted.
The digest binds both policies, archive verification counts, the approved host-reader
digest map and the actual reader hash. Switching between the two host readers changes
the digest and requires fresh preparation and exact-digest approval before execution.
The historical preparation digest above does not approve this revised contract.

Run `npx --no-install jest --config jest.gate1-build-tools.config.cjs --ci --runInBand --no-cache`
for the tracked CJS suites in Node, with no transforms, inBand and no cache.
CI invokes this configuration directly to preserve the reviewed `package.json`
hash checked by the restart-continuity harness. Validate the archive suite with each supported
host installation so both actual reader implementations and reported hashes are checked. Run six `node --check`
commands, focused ESLint, whitespace and preservation checks. Tests use synthetic/mock cases plus an isolated temporary Git repository under
`.tmp/gate1-archive-tests/`. The real Git regression commits text and binary fixtures,
checks a CRLF checkout, reproduces archive drift, and proves the corrected archive
matches committed blob IDs. It verifies containment before removing its own fixture.
Tests do not install dependencies, invoke Docker or send HTTP requests.
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
