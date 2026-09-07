# Reviewed TS source windows

All 84 source fixtures and their 84 human-reviewed window goldens come unchanged
from TS revision `122674c8bfbbc3549390743f51396c5f0e4e3537`:

- [Source fixtures](../../../../tests/fixtures/source-windows)
- [Original goldens](../../../../tests/goldens/source-windows)
- [Rust tests](../../../../tests/unit/ts_v2_source/reviewed.rs)
- [Captured reference](reference.json)

The reference records complete chunk trees and projected windows, including
parent/owner indices and byte/line spans. TS UTF-16 offsets are converted to
UTF-8 byte offsets in normalized source. Each fixture has three projections:
the original reviewed target, 80 UTF-16 units, and the production 4,000-unit
target. Names, kinds, nested ownership and exact source boundaries are checked
before embedding or storage.

The Rust tests call production language dispatch. They also reconstruct each
root from contiguous windows, check complete leaf coverage, reject gap/blank
documents, and check that boundaries retain indentation. Every fixture is
parsed again for determinism and with a BOM and CRLF line endings. The latter
comparison maps raw Rust spans back to normalized TS spans. The original
goldens are rendered with the production preview helper. A small test separately
checks the TS compact-preview example, an indivisible long line, and a zero
window target.

Run all 28 checks with:

```sh
cargo test retrieval::ts_v2::tests::reviewed
```

These tests run as part of ordinary `cargo test`. They require neither Bun,
network access, nor model assets.

To capture a fresh reference from an extracted TS checkout with its pinned Bun
dependencies installed:

```sh
bun benchmarks/versions/port-source-windows-reference.ts /path/to/pinned-v2 /tmp/source-windows-reference.json
```

The exporter verifies the checkout's source, package manifests, lockfile, test
suite, fixtures, and goldens against the archived Git blobs before importing
the TS implementation. It executes TS chunking and projection and requires
every original reviewed golden to match. It also checks that the suite's case
list covers every archived fixture. It refuses to overwrite an existing output
file. Compare the new output with `reference.json` before replacing anything;
never regenerate expected output from Rust to make a failing test pass.

SHA-256 hashes in the reference protect the imported fixture/golden bytes.
The Rust inventory check rejects missing, duplicate, extra, or modified files
and checks fixture evidence for every archived native extension. It does not
claim new language coverage beyond the archived examples.

This corpus is distinct from TS's 272 general chunker fixtures, which also test
source facts. Their remaining coverage is listed in the [test map](../TEST-MAP.md).
