# GATE-1: inventoried absent local source-map targets

Implementation and review preparation were approved by the owner's `go` following
the named-file proposal. Retained-content execution remains separately unapproved.
Artifact privacy is unqualified; GATE-1 remains open.

This is a separate amendment to the unchanged local remediation plan at
`docs/UIDesign/error-pages-auth-correctness-remediation-plan.md`, SHA-256
`4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f`.
All predecessor plans, snapshot resolutions, helpers, receipts and consumed
approvals remain unchanged. This amendment does not rewrite their policy meaning.

The consumed lexical diagnostic under approval
`1a449d37c809863a3ea496988bcdd074e9dcae1bef7ee8a93de96c7aeb514a22`
identified `target_not_map_suffix`, an absent target, and a genuine
`line_comment_directive`. It established neither exposure nor an artifact-privacy
pass. No additional lexical or link-structure diagnostic is necessary.

## Approved implementation contract

The distinct opt-in `sourceMapPolicy: emitted_inventory_v2` permits absent local
targets regardless of their filename suffix only after the complete emitted
physical, alias and projected name inventory proves absence. Strict/default
rejection and `emitted_inventory_v1` keep their previous meaning. Generated
qualification drafts continue to select v1; changing a policy changes approval.

Raw syntax, decoding and containment checks run before absence can be accepted.
Every physical, alias and projected resolution context is checked. Present
non-`.map` files, directories, implicit projected parents and paths below known
regular files remain rejected. Permitted absence cannot bypass a later unsafe
context. Present `.map` files retain all existing format and privacy checks.
Reference targets are never opened or fetched. Emitted files are inspected through
the existing complete inventory, including unreferenced and inline maps, supported
decoded representations and logical names. Existing filesystem protections,
fingerprints, mutation checks, resource budgets and privacy comparisons remain.

Reports retain `absent_local_source_maps_not_inspected` and
`source_mapping_url_matches_are_syntactic_not_lexical`, with bounded aggregate
reference/context counters and explicit availability status. A single lexical
diagnostic does not prove the interpretation of every syntactic scanner match.

## Review preparation and proposed scan

The scanner patch is based on staging commit
`59383771fb1a63c7caf5c890134f4c9f82ace99a`; main commit
`62f500094803ee1fc5a5b72107eedf14d0ca490b` has the same source tree. The completed
lexical classifier is preserved locally; PR #295 is still open and contains its
earlier scaffold. The new scanner patch is not claimed to be published.

The retained image supplies the exact older, hash-verified companion scripts.
The review binds those companions separately from the current patched scanner;
the generated Linux fixture checks the actual combined approval before a real
scan may be approved. No image rebuild or dependency download is included.

The proposed one-time scan uses the existing independent copy of synthetic source
`d85af7e33cc01d386ec71247b06da250c6b9f473`, fingerprint
`868494a0921bfc7ce7c8d0dd4c17b5d0b87de830453c5d6c11e113aa02a03966`.
The copy and original fixed synthetic comparisons/pinned dependency code are
mounted read-only. Neither original artifact contents nor artifact code are used.
Both retained volumes and all consumed approvals remain preserved.

Limits remain 128 MiB copy verification, 1 GiB raw/decoded/name scanner budget,
100,000 mapping references, 200,000 expanded visits and 64 MiB projected names;
180 seconds active work, 150-second Linux timeout, 120-second scanner deadline,
20 seconds exceptional cleanup, two CPUs and 2 GiB RAM. The fresh review discloses
all other inherited bounds, sanitized output handling and storage limits.

Success requires complete declared emitted-inventory coverage, matching copy and
scanned-byte fingerprints/counts, zero configured privacy findings, explicit
absent-map limitations, durable sanitized evidence and confirmed cleanup. Any
failure, finding, unsupported structure, mutation, incomplete coverage or cleanup
uncertainty stops the attempt without retry or automatic policy changes.

The only possible pass claim is `no_matches_in_checked_representations` for this
reviewed synthetic inventory. Absent map contents, historical/Production
credentials, hosted equivalence and the remaining GATE-1 obligations are not
qualified. Preserve the shared 400-request ceiling and separate hosted checks.
Sequence remains GATE-1 -> CHUNK-5A/GATE-5A -> CHUNK-2/GATE-2 -> CHUNK-3.
