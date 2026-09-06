# Go retrieval check

This development check adds four Go files to the existing 14-file Rust,
Python and JS/TS corpus. It covers receiver methods, grouped declarations,
documentation and an answer near the end of a large method.

The six queries and expected owners in `queries.json` were frozen before
inference. They were prepared from the source and are not held-out quality
measurements. `results.json` records the binary, model, corpus and query hashes.

| Query | Expected declaration | Top-10 owner rank | Answer visible |
| --- | --- | --- | --- |
| G1, expire tokens by Unix seconds | `Store.RemoveExpired` | 1 | yes |
| G2, close a remote socket | `Remote.Close`, with `Local.Close` as a distractor | 1 | yes |
| G3, scheduler retry documentation | `SchedulerRetry` | 1 | yes |
| G4, HTTP client identifier | grouped variable `UserAgent` | 1 | yes |
| G5, cancel waiting for shutdown | `Service.Shutdown` | absent | no |
| G6, strip URL fragment and slash | `NormalizeURL` | 1 | yes |

G5 is a ranking miss. A diagnostic with the same query, corpus and limit 64
finds `Shutdown` at rank 11 and displays the `ctx.Done()` and `ctx.Err()` branch.
The method has three embedding parts and deliberately repetitive diagnostic
statements before the answer. The saved source is complete, including its last
branch. The query, corpus, model and chunk rules were not retuned after the miss.

The index contains 77 documents across 18 files. The audit verifies complete
nonblank source coverage, exact UTF-8 and line ranges, and six repeated
signatures. Every cited source fragment occurs in its own displayed text block.
Search runs after deleting the working sources, using saved snapshots.

The checker also verifies:

- Upgrade from binary `176eace`, which treats `.go` as text fallback. Search and
  stored inspection reject the old policy without writing to the database.
  Reindexing unchanged source creates Go owners and retains all existing-language
  document text and evidence.
- Reuse of all 18 unchanged files, identical direct/stored inspection, and stored
  inspection after source deletion. The existing config stays unchanged.
- Replacement of one Go and one TS file, plus removal of a deleted Go file.
- One chunk per embedding call with the existing CPU worker limit. The recorded
  run used three workers on ten available logical CPUs.

## Reproduce

Build the current release binary and revision `176eace` in separate checkouts.
Use a new output directory. The checker retains its project, saved inputs,
profile and command output there.

```sh
cargo build --release
python3 benchmarks/retrieval/go/check.py \
  --binary target/release/mimirs \
  --previous-binary /path/to/176eace/target/release/mimirs \
  --model-snapshot /path/to/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-go-check
```

`--model-snapshot` supplies files for hashing. The CLI uses its normal cache
and the model revision pinned in the binary. G5 at limit 64 is an additional
diagnostic, separate from the original top-ten results.

Unit and CLI tests cover group ownership, multi-name specs, aliases, receiver
headers, comment attachment, storage, reuse, failed replacement and discovery.
Every partial prefix of the declaration fixture must retain valid stored
analysis and exact source coverage, including its CRLF form. Token-budget tests
include large types, long signatures and single-line bodies with Unicode.

```sh
cargo test
cargo test -- --ignored --test-threads=1
```

The ignored tests load model assets and can download them when absent.

## Limits and existing-language checks

Group documentation and separators belong to the group. A later constant with
an omitted expression retains only its written source; mimirs does not compute
`iota` or copy an earlier expression into that constant's chunk. A query needing
that context can require another result. Methods use their written receiver
header without type lookup or cross-file ownership.

The pinned Go grammar reports a recoverable missing separator for compact forms
such as `const (One = iota; Two)`. The recovery test verifies that analysis and
chunking still preserve that source. Parse diagnostics describe the grammar's
output and do not replace Go compiler checks.

`regression-results.json` records the fixed Rust, Python, JS/TS and Maturin
checks. Repeat the existing `../compare.py`, `../python/check.py`,
`../javascript/check.py` and `../mixed/check.py` with the current binary.
The JS/TS upgrade checker needs a binary from before JS/TS support, `7c1841b`.
The mixed checker needs its pinned checkout indexed first with the documented
Rust/Python config. The regression report compares saved input hashes and frozen
ranks; the new Go fixture does not change those existing corpora.

Rust retains 246 inputs and ranks `1, 7, 1, 1, 1`. Python retains 22 inputs
and three rank-one answers. JS/TS retains 51 inputs and six rank-one visible
answers. Maturin retains all 272 supported files and 2,817 documents; its source
inputs, vectors and config are byte-identical to the previous binary's index.
All frozen owner ranks and visible-answer checks remain unchanged. Its known
misses remain, including incomplete answers to both cross-language queries.
