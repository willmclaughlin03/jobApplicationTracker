# Original-source offline reproduction

This directory publishes the exact local helper and synthetic tests prepared for one
GATE-1 troubleshooting attempt against application source
`0e89e234b483b9dc6ab1c374b2064532af8fb789`. Publication does not execute or approve an attempt.
The original build and one-file diagnostic approvals remain consumed; GATE-1 remains open.

The helper prepares dependencies in a new volume from the pinned retained image and runs
the original offline postinstall and Vercel Preview command. Separate preparation/build
containers preserve the fresh temporary HOME boundary. Each has a 30-minute deadline,
4 CPUs, 6 GiB memory, disabled networking and disabled daemon logging. The original
qualification volume is never mounted. New reservations are consumed before mutation;
uncertain creation, teardown or persistence retains the shared lock for review.

Both output streams are bounded in Linux memory. Only reconstructed diagnostics with
public source/dependency references can leave the supervisor. The host validates them
again. Unknown text, raw logs, environment values and code frames are discarded.
The result may identify a missing module, preflight variable name, recognized syntax
message, public error literal or system/cache code. Unsupported output can remain
inconclusive; no automatic retry or broader read follows. The first recognized error
is not proof of root cause or a reliable ordering across stdout and stderr.

## Exact reviewed bytes

- `reproduce.js`: SHA-256 `0637e26f2cdf3c833392041d60bb0c4118d0e22346631fb1b2c90ab13901d550`
- `__tests__/reproduce.test.js`: SHA-256 `7dc8199848fc3fb434be3adea344d266638959c87b3621b80f35ca3248f76a34`

These copies deliberately preserve the existing local helper bytes. The owner-reviewed
execution copy stays at `.tmp/gate1-reproduction-0e89e234/` in the original repository.
Use that copy and its reviewed contract for the pending attempt. Moving execution to
this publication directory would change where review files are read/written and requires
a new concrete review. Do not overwrite the existing approved copy or its records.

## Local prerequisites and tests

This is a fixed local troubleshooting helper, not a portable command-line product. Its
original-source checkout, immutable cached inputs, public receipts and approved execution
contract are prerequisites. They are intentionally absent from this PR. The authoritative
local remediation plan, review files, reservation files and generated output stay local.

The tests use Node's test runner and mocked Docker; no container or application build runs:

```powershell
node --test scripts/gate1-reproduction-0e89e234/__tests__/reproduce.test.js
```

They require the original qualification helper at
`.tmp/worktrees/gate1-qualification-main-0e89e234-lf/scripts/gate1-build-qualification.js`,
relative to the checkout root. Its required SHA-256 is
`dd665377170f160f7edb012d2cabde690730b8622f49a19ff353345e2dca4736`.
For synthetic tests in an isolated checkout, that single byte-verified public helper
may be copied into the ignored prerequisite path. This test fixture does not satisfy
the clean original-source Git checkout, cached-input, receipt or execution-approval
checks required by a real attempt. Do not copy any failed workspace or private evidence.

All 63 focused synthetic tests pass, along with focused lint, Node syntax and whitespace
checks. They cover output privacy, chunk boundaries, limits, deadlines, provenance,
container settings, reservation consumption, evidence preservation and failure cleanup.
No successful application build, live Linux-isolation qualification or artifact-privacy
pass is claimed. Artifact inspection remains a later separately approved operation.
