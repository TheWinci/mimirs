# General chunker and language fact reference

Pinned TS revision: `122674c8bfbbc3549390743f51396c5f0e4e3537`.

`reference.json` records all 272 cases from `tests/chunker.test.ts`. These also
include every fixture used by the language fact and JavaScript/TypeScript
variant suites. Each record contains normalized source, the complete chunk tree,
all semantic facts, and original fixture/tree-golden/fact-golden SHA-256 hashes.
The original bytes live under `tests/fixtures/ts-v2-chunker` and
`tests/goldens/ts-v2-chunker`.

Regenerate from an installed checkout of the pinned TS revision into a new file:

```sh
bun benchmarks/versions/port-chunker-reference.ts /path/to/pinned-v2 /tmp/chunker-reference.json
```

The exporter verifies archived source and test hashes before executing TS and
requires both original rendered goldens to match. It converts TS UTF-16 offsets
to UTF-8 byte offsets, preserving every other fact field. Do not regenerate
expected output from Rust or edit original goldens to accommodate a mismatch.

`tests/unit/ts_v2_source/chunker.rs` compares production Rust trees and semantic
facts with the full capture. It checks every original hash, repeats fact checks
with BOM/CRLF input, and round-trips complete analyses through SQLite. Separate
text cases cover whitespace gaps, empty input and arbitrary extensions.

The port fixed annotation attachment for several native languages and translated
the TS fact extractors to native tree-sitter nodes. Dart method invocations need
an adapter because its native grammar represents selectors differently. The
analyzer identities and retrieval policy were bumped so old snapshots rebuild.
