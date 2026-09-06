# TypeScript and JavaScript retrieval check

This development check covers TS, TSX, JS and JSX source retrieval with the
pinned MiniLM model. The 14-file corpus also contains the existing Python
fixtures and Rust distractors. It includes `.mts`, `.cts`, `.mjs`, `.cjs`, and
`.d.ts` declarations.

The six queries and expected owners in `queries.json` were written before the
first inference run. They were prepared from the source, so this is a retrieval
and evidence check, not a held-out quality evaluation. `results.json` records
the binary, corpus, query and model hashes.

| Query | Expected source | Top-10 owner rank | Answer visible |
| --- | --- | --- | --- |
| T1, expire browser tokens | `cache.ts`, `TokenCache.removeExpired` | 1 | yes |
| T2, restore a JSON cache | `cache.ts`, `TokenCache.restore` | 1 | yes |
| T3, retry delay documentation | `contracts.d.ts`, `RetryPolicy` | 1 | yes |
| J1, normalize a shortcut | `keyboard.mjs`, `normalizeShortcut` | 1 | yes |
| J2, normalize CRLF | `newlines.cjs`, anonymous default function | 1 | yes |
| X1, disable reconnect while busy | `reconnect.tsx`, `ReconnectPanel` | 1 | yes |

The index contains 51 documents. The source audit found complete nonblank byte
coverage, exact UTF-8 and line ranges, and three repeated signatures. The large
TSX component places its answer near the end, beyond the first embedding input.
Each displayed evidence fragment must occur in its own displayed text block.
Queries run after deleting the working sources, using their saved snapshots.

The previous binary, built from `7c1841b`, initially indexes JS/TS as text
fallback. The current binary rejects search on that policy without changing the
database. Reindexing unchanged source builds syntax owners and preserves Rust
and Python document text and evidence. A second index reuses all 14 files.
Direct and stored inspection agree for both analysis and source previews.
Subsequent TS and Python edits rebuild two files; deleting a JS file removes it.
The existing config remains unchanged throughout.

The recorded run uses the default limit of three workers on ten available
logical CPUs. All 51 embedding calls contain one chunk. This check verifies the
existing worker policy; its small corpus does not establish an indexing speedup.

## Reproduce

Build the current release binary and the previous revision in separate
checkouts. Use a new output directory; the checker keeps the project, input
text, index profile and command output there.

```sh
cargo build --release
python3 benchmarks/retrieval/javascript/check.py \
  --binary target/release/mimirs \
  --previous-binary /path/to/7c1841b/target/release/mimirs \
  --model-snapshot /path/to/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-javascript-check
```

`--model-snapshot` identifies the model files for hashing. The CLI uses its
normal model cache. The model revision is pinned in the binary.

The grammar fixtures also cover decorated classes and fields, bodyless
overloads, nested namespaces, anonymous exports, destructuring, computed names,
static blocks, malformed input, CRLF and Unicode. Every partial prefix of each
fixture must retain valid stored analysis and exact source coverage. The
explicit real-model test checks a long TSX line against the 512-token budget.

```sh
cargo test
cargo test -- --ignored --test-threads=1
```

The ignored tests load model assets and can download them when absent.

## Existing-language regressions

`regression-results.json` records the unchanged Rust and Python fixtures and
the pinned Maturin checkout at `479658ad9bce22c6e4955b2e47182111c166e37c`.
Run the existing `../compare.py`, `../python/check.py`, and `../mixed/check.py`
with the current release binary to repeat them. The mixed checker requires
indexing its checkout first with the config from `../mixed/README.md`.

- Rust keeps 246 document inputs and ranks `1, 7, 1, 1, 1`.
- Python keeps 22 document inputs and ranks `1, 1, 1`.
- Maturin retains all 272 supported files and 2,817 documents. Its document text,
  evidence and single-chunk vectors are byte-identical to the pre-upgrade index.
  Every frozen owner rank and visible-answer check remains unchanged.

Maturin still answers five of seven Python queries and six of seven Rust queries
within the top ten. Neither cross-language query yields all required targets.
The manifest-resolution diagnostic still finds `unpack_sdist` at rank 41 with
its answer visible at limit 64. Language expansion does not resolve those
ranking or cross-language limitations.
