# Gate 1 bounded build attribution

This operator package gathers a bounded build-attribution sample for deployment
`dpl_9LmYSk5o8f4EN81ghftV4mEiMCGJ`, source
`f3d6eade32bd3113b0f75e12e5496be123a77ac1` and Next build
`BnCHVak4WzTSkPU5n2IXn`. It does not repeat the completed session-runtime observation.
Gate 1 remains open, Gate 5A remains unpassed, and immutable rollback has not run.
Publishing this package does not execute or authorize hosted qualification.

## Local prerequisites

This package requires the preserved Windows qualification workspace, its installed
dependencies, the clean reviewed source worktree, pinned Vercel CLI 62.2.0 and the
historical packages/evidence named by `LOCAL_PINS` and the preparation manifest.
A fresh clone alone cannot satisfy preparation or these operator integration tests.
The required local helpers are:

- `.tmp/gate1-rollback-tools/post-main-f3d6eade-attempt-2/`
- `.tmp/gate1-rollback-tools/runtime-9LmYSk5o-attempt-1/`

Those helpers, their evidence and credentials are not included in this directory.
The imports resolve through `GATE1_REVIEW_WORKSPACE`; they do not assume that the
frozen helpers were copied beside this tracked package. That nonsecret setting
defaults to this checkout's root. `GATE1_VERCEL_CLI_DIST` optionally selects the
already installed CLI directory; every CLI pin must still match.

Never read `.env` files or credential storage directly. The CLI loads its existing
managed authorization only during a separately approved live run. Missing or
expired authorization stops without refresh, retries or a login flow.

## Offline preparation and validation

Run from the checkout containing this package, using the existing qualification
workspace for dependencies and evidence:

```powershell
$repo = 'C:\Users\willm\job-application-tracker'
$env:TEMP = Join-Path $repo '.tmp'
$env:TMP = $env:TEMP
$env:NODE_PATH = Join-Path $repo 'node_modules'
$env:GATE1_REVIEW_WORKSPACE = $repo
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$package = 'scripts/gate1-rollback-tools/build-attribution-9LmYSk5o-attempt-1'
foreach ($file in @('observe-build.cjs', 'provider-read-child.cjs', '__tests__/observe-build.test.cjs', '__tests__/provider-read-child.test.cjs')) {
  node --check (Join-Path $package $file)
  if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed' }
}
node (Join-Path $package 'observe-build.cjs') --prepare
```

Preparation validates dependencies/source and prints a manifest and digest. It
creates no execution evidence and sends no live requests. The manifest binds all
four package files, source inventory, historical manifests/evidence, CLI pins,
workspace and local Node version. The tracked copy has different import bytes and
a different digest from the frozen `.tmp` copy. Review the digest of the exact copy
that would execute; approval of one copy does not approve another.

The dedicated Jest suites use mocked provider/network/process adapters and
in-memory evidence writes. A preparation integration test uses read-only Git
subprocesses and the preserved local dependencies. Run them with an isolated
configuration so the repository's ordinary `src/` test roots do not exclude them:

```powershell
@'
const path = require('node:path');
const repo = process.env.GATE1_REVIEW_WORKSPACE;
const root = path.join(process.cwd(), 'scripts/gate1-rollback-tools/build-attribution-9LmYSk5o-attempt-1');
require('jest').runCLI({ runInBand: true, cache: false, config: JSON.stringify({
  rootDir: root, testMatch: ['**/__tests__/*.test.cjs'], testEnvironment: 'node',
  transform: {}, moduleFileExtensions: ['js', 'cjs', 'json'],
  moduleDirectories: [path.join(repo, 'node_modules'), 'node_modules'],
  cacheDirectory: path.join(repo, '.tmp/jest-build-attribution-cache')
}) }, [root]).then(({ results }) => { process.exitCode = results.success ? 0 : 1; });
'@ | node
```

The standard CI unit-test configuration does not automatically run these dedicated
operator suites. Focused ESLint and whitespace checks also apply to the new files.
Use normal sandbox escalation if the read-only subprocesses are blocked.

## Separately authorized live scope

Only after review and explicit approval of the exact prepared digest:

```powershell
node (Join-Path $package 'observe-build.cjs') --execute <approved-package-digest>
```

The fixed sequence is alias before, anonymous canonical `/login`, pinned deployment
metadata, pinned build-output metadata, bounded build events, anonymous `/login`
again, and alias after. `PROFILE.providerOperations` contains the exact endpoint
and project/team parameters. No project mutation or application runtime probe runs.

| Bound | Limit |
| --- | --- |
| Provider/application requests | Five provider GETs and two anonymous login GETs; concurrency one |
| Deadlines | 120 seconds for the exercise; 10 seconds per HTTP request; 30 seconds per provider child |
| Response/header bytes | 1 MiB response and 16 KiB headers per request |
| Events | Finite JSON, `follow=0`, forward order, `builds=1`, `delimiter=0`, `limit=500`; receiving 500 stops as capped evidence |
| Event text | 8 KiB per event and 10,000 lines total |
| Build metadata | 64 builds, 2,048 outputs, 1,024 routing rules |
| IPC/discarded child output | 128 KiB each |
| Retained report | 256 KiB |

There are no retries, redirects, pagination, authentication refresh, telemetry
uploads or credential prompts. Normal CLI device/session metadata writes and
ordinary application logging/limiter effects remain part of the live scope.

Before any provider dispatch, exclusive reservation creates these three files
beneath the qualification workspace:

```text
.tmp/gate1-rollback/replacement-9LmYSk5o-build-attribution-attempt-1/profile.json
.tmp/gate1-rollback/replacement-9LmYSk5o-build-attribution-attempt-1/reservation.json
.tmp/gate1-rollback/replacement-9LmYSk5o-build-attribution-attempt-1/report.json
```

The tracked and frozen local copies share that one attempt destination. Never run
both or delete/reuse its reservation. Partial writes, cancellation and failures
consume the attempt. Target/build/alias drift, contradictory facts, malformed or
capped metadata, provider/authentication failure, deadline/protocol violations,
dependency/source changes and checkpoint failures stop without automatic replay.

## Evidence limits

Raw logs, provider payloads, arbitrary paths, headers, cookies and credentials are
discarded. Only known source routes, bounded counts, strict version claims and
allowlisted function metadata can enter evidence. Missing versions stay missing;
unknown paths are counted without retention.

`observed_with_gaps` means the seven-phase sample completed on the pinned target.
It does not qualify exact local/deployed manifests, complete installed versions,
all-route runtime/smoke behavior, cold starts, environment compatibility or rollback.
Source-lock versions, build-log claims and the historical session runtime remain
separate evidence classes. Alias samples do not exclude intervening changes, and
dispatch announcements are not an independent physical HTTP audit.

The events method follows the [Vercel events API](https://vercel.com/docs/rest-api/deployments/get-deployment-events).
Deployment metadata follows the [deployment API](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url).
The builds endpoint follows the locally reviewed, pinned CLI's inspect implementation;
its availability/completeness on this project is not assumed.
