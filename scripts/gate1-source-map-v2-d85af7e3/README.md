# Completed local source-map diagnostic

This directory publishes the exact v2 diagnostic and synthetic test source used
for the retained GATE-1 output from application source `d85af7e33`. It is a
snapshot of an evidence-bound local tool, with prerequisites outside Git.

The approved attempt completed once. It identified `target_not_map_suffix`, an
absent target, and physical context after two accepted absent-map references.
Fingerprint/inventory verification and cleanup passed. This identifies the
scanner predicate, but does not establish whether the match is a real comment
or literal text. Artifact privacy remains unqualified; GATE-1 remains open.

The approval is consumed. Publication does not authorize another attempt.
Keep the authoritative execution copy and all its receipts unchanged under
`.tmp/gate1-source-map-v2-d85af7e3/` in the original owner workspace.

## Source identity

- `diagnose.js`: SHA-256 `67a2a584ffa128b972cfee7466148725dc6aa6ca066f76c369905529f9a91a19`
- `__tests__/diagnose.test.js`: SHA-256 `f6a481dd28416c07bc2763a8927a737f498ebbafa62d8f0ed33d47005cc9c73a`

The reader intentionally binds the historical scanner at staging merge
`b76b531e56f346bca88562d5d2b68e477a20eaca`, rather than following newer branch
heads. The newer PR base does not update that execution provenance.

## Local prerequisites and validation

The helper requires the hash-verified predecessor at
`.tmp/gate1-absent-source-maps-d85af7e3/run-scan.js`, its complete receipt/helper
chain, and the historical LF source checkout. Import or preparation fails closed
when those prerequisites are absent or changed. A clean clone cannot run these
tests without the owner's local evidence. Do not publish that evidence or create
substitute receipts to make tests pass.

The exact local bytes passed 34 host tests and 75 generated Linux fixtures,
plus syntax, focused lint and whitespace checks. Linux fixtures used the pinned
offline image and mounted neither retained volume. Publication carries those
results by byte identity; it does not claim a fresh Linux test or content read.

The tests use Node's test runner and are outside the default Jest roots. In the
original workspace, the authoritative host command is:

```powershell
node --test --test-reporter=spec .tmp/gate1-source-map-v2-d85af7e3/__tests__/diagnose.test.js
```

Do not run this published copy's execution command or relocate the consumed
execution. The next work is the separate
[lexical reader scaffold](../gate1-source-map-lexical-d85af7e3/README.md).
