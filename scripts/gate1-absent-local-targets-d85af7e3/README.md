# Local absent-target scan adapter

This directory publishes byte-identical snapshots of the reviewed local adapter,
focused tests and pre-execution policy amendment from
`.tmp/gate1-absent-local-targets-d85af7e3/`. The reusable scanner change is in
`scripts/gate1-build-artifact-privacy.js`.

The new opt-in `emitted_inventory_v2` accepts local source-map targets of any
suffix only when the complete physical/alias/projected inventory proves absence.
Strict defaults, v1 and generated qualification drafts retain their previous
meaning. Present non-map files, directories including the output root, unsafe
contexts and other existing rejection conditions remain protected. Absent map
contents are explicitly uninspected; reference matching remains syntactic.

## Source identity and prerequisites

- `run-scan.js`: SHA-256 `91222d847d6080e25c2f9b9ffef14477cbe9fb49760081a3de4dd79cad471e2b`
- `__tests__/run-scan.test.js`: SHA-256 `2c0ce07b594246f3f69bd575d3b7a2f8ca73c63625fbc6abc13f9619b962c657`
- `policy-amendment.md`: SHA-256 `70ae8324ee965e1cb789c712da3bbbe3e8faef83fae62f4c38bc4be3d5f843ed`

The adapter requires the complete ignored local helper/receipt chain, including
the frozen prior scan and completed lexical diagnostic, and the exact reviewed
LF worktrees. Those prerequisites are intentionally absent from Git. A clean
clone cannot import or run this evidence-bound tool. Do not weaken its checks or
publish private receipts to make it runnable. The preserved local directory is
authoritative; moving execution to this publication directory requires a fresh
concrete review. This snapshot is not an additional execution approval.

The pinned retained image supplies older companion scripts whose exact hashes
are verified separately from the revised scanner. A generated Linux integration
fixture verifies the actual combined scanner approval. No image rebuild or
dependency download is needed for this adapter's reviewed operation.

## Validation and consumed attempt

The final implementation passed 423 targeted scanner/qualification tests, 42
focused adapter tests and 67 generated Linux fixtures, plus syntax, zero-warning
lint and LF/whitespace checks. Linux fixtures used generated data and a read-only
public dependency mount, with no retained artifact volumes. The published source
and test snapshots match those validated bytes; they are not separately runnable
in an ordinary clean checkout.

The one approved local scan has already consumed its reservation. Full-copy
verification passed, then scanning stopped at `map_contract` after recording
1,196 of 2,378 physical files. No configured privacy findings were reported in
the completed portion. Exit status was 1 without OOM; cleanup was confirmed and
both volumes were retained. No retry ran. Raw content, private comparisons and
execution receipts are not part of this publication.

`policy-amendment.md` is the immutable pre-execution snapshot; its pending-approval
language describes preparation time. The later approval is consumed. A bounded
investigation of the remaining source-map validation failure requires separate
review and authorization. Artifact privacy remains unqualified; GATE-1 is open.
