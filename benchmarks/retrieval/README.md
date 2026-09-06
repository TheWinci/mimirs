# Source-chunk retrieval check

The CLI embeds tree-sitter source chunks for Rust and Python, and paragraph
chunks for included unsupported text. Facts remain structured analysis. The raw-line and
facts-description embedding modes have been removed to reduce scope.

The fixed corpus is 26 Rust source files from `425fbbe`. The same five prepared
queries, expected files, and pinned MiniLM model are retained. This is a regression
check on development requests, not a held-out evaluation or a general quality claim.

```sh
cargo build
python3 benchmarks/retrieval/compare.py \
  --binary target/debug/mimirs \
  --model-snapshot /path/to/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-source-check
```

The script creates temporary projects, indexes source chunks, and saves the full
CLI outputs, `source-inputs.json`, and `report.json` in the output directory.
It hashes the corpus, queries, binary, model files, and exact embedding inputs.
An input audit verifies that every non-whitespace source byte occurs in exactly
one primary source fragment, all byte and line ranges match, each document ends
with its source fragment, and repeated signatures match the recorded evidence.
The indexer checks complete input lengths with the production tokenizer.

Search results group documents by entity, with ownerless blocks grouped by file.
Ranks count unique files among up to 64 returned hits. File rank does not establish
that a result contains enough evidence to solve the task. Indexing times come
from single cached-model runs and are not controlled performance measurements.

The [historical comparisons](HISTORY.md), their JSON reports, and exact leading
[source examples](source-examples.txt) retain the earlier experiment. In that run,
source used 246 vectors versus 2,585 raw lines; it improved two expected-file ranks,
regressed one, and tied two. Keeping source as the only strategy is a scope choice.

## Single-strategy verification

[source-only-results.json](source-only-results.json) records the schema-8 run.
It produced the same 246 inputs and exact input hash as the earlier source run,
with unchanged expected-file ranks of `1, 7, 1, 1, 1`. The model files, corpus,
and queries also have identical hashes. The audit checked all 26 files and 30
repeated signatures, with complete non-whitespace coverage and exact source bytes
and line ranges. Indexing took 12.06 seconds in this single cached-model run.

This verifies that removing the alternate modes preserved the measured Rust
source representation. It does not establish quality on new repositories or
languages. Ordinary comments outside items remain ownerless chunks; a model can
rank such a comment above the corresponding function. Explicit Rust doc comments
stay attached to their item.

## Language dispatch verification

[language-dispatch-results.json](language-dispatch-results.json) records the
shared language dispatch run. All 246 embedding inputs, their exact hash, and
the five query rankings match the source-only baseline. The source audit also
matches, including all 30 repeated signatures. Analyzer registration and
extension mappings now contribute to cache compatibility, while Rust source
representation stays unchanged. Timing was collected alongside other model
checks and is not a performance comparison.

The [Python retrieval check](python/README.md) covers mixed Python/Rust source,
stubs, named-owner ranking, and upgrades from Python fallback indexing.
