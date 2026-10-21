# Local lexical reader: step 1 scaffold

This directory publishes the exact step-1 source and focused tests from
`.tmp/gate1-source-map-lexical-d85af7e3/` in the original owner workspace.
It prepares a separate draft for classifying the exact source-map marker rejected
by the completed v2 diagnostic. It does not yet perform lexical classification.

The scaffold verifies the consumed v2 receipts, assigns distinct container and
reservation identities, reuses the bounded reader and mount verifier, and adapts
the existing one-attempt reservation/report/cleanup lifecycle. An unconditional
gate rejects execution, bootstrap generation, result validation and Docker
readiness before side effects. Preparation returns `approval: null` and
`executionReady: false`; its draft hash is not execution authorization.

## Source identity and prerequisites

- `diagnose.js`: SHA-256 `fbb1f0ed8d565491db6273119373cde0981e73bf87bc66bfff20c7b7828ef90a`
- `__tests__/diagnose.test.js`: SHA-256 `6f78ff06014586adc20af5ac5718b18cc4a564c8e9ee1af373ca14ef3e3daf00`

The required predecessor is the frozen local
`.tmp/gate1-source-map-v2-d85af7e3/diagnose.js`, including its complete historical
receipt/helper chain. These prerequisites are intentionally absent from Git.
A clean clone cannot import or run this evidence-bound tool; failure on missing
local evidence is expected. Do not weaken its checks or copy private receipts
into a PR to make a clean clone runnable.

The authoritative local directory also holds six draft preparation/review JSON
records. They remain local. Future changes must update those draft records;
the consumed v2 files and their indexes stay immutable. Moving execution to
this publication directory requires a separate concrete review.

## Validation and remaining work

All 13 focused scaffold tests passed, along with syntax, lint and LF/whitespace
checks. They cover draft identity, predecessor drift, distinct resource names,
and rejection before execution side effects. The adapted lifecycle has not been
exercised through the closed gate. No lexical parser, Linux fixture, Docker
readiness check or retained-content operation ran during step 1.

The tests use Node's test runner outside the default Jest roots. In the original
workspace, run the authoritative scaffold tests with:

```powershell
node --test --test-reporter=spec .tmp/gate1-source-map-lexical-d85af7e3/__tests__/diagnose.test.js
```

Next, implement the exact-match lexical classifier using the existing Acorn
8.15.0 only after verifying its cached-package integrity. Bind parser options,
work limits and public-code transport before preparing a final execution review.
Use complete parsing and comment/token ranges; no artifact code is executed.
Keep source text, reference values, offsets and parser errors out of retained
results. Unsupported syntax or ambiguous classification stops without guessing.

After focused host/Linux validation and metadata readiness, obtain separate
approval for one bounded read of the existing verified copy. A confirmed literal
match may justify a later comment-aware scanner proposal; a genuine unresolved
directive supports an unsupported-output disposition. Neither outcome by itself
qualifies artifact privacy or closes GATE-1.
