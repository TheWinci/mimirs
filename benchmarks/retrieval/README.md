# Rust retrieval comparison

The September 5, 2026 comparison keeps raw retrieval as the default. Facts
produce precise entity locations and source evidence, but these five requests
show two regressions and one improvement in expected-file rank.

| Request | Raw file rank | Facts file rank |
| --- | ---: | ---: |
| Stop batches when progress fails | 1 | 1 |
| Reuse complete unchanged output | 5 | 6 |
| Reject unknown database schemas | 1 | 1 |
| Record written method-call receivers | 2 | 14 |
| Remove deleted-file vectors | 2 | 1 |

Ranks count unique files among up to 64 returned hits. Either listed target file
counts for deletion, whose work spans storage and reconciliation. This compares
file discovery only; raw results have whole-file locations, while facts results
have entity locations. Five self-authored requests in one Rust repository do not
establish general retrieval quality. Queries were written from the requests and
kept unchanged before adding target labels. The author knew this repository;
this was not a blinded user study or a held-out benchmark.

Both runs used the same 26 Rust source files from commit `425fbbe`, excluding
unit tests, and the cached Qdrant MiniLM model revision recorded in `results.json`.
The model/tokenizer files were hashed before and after the comparison. Initial
indexing took 11.13 seconds for raw and 26.03 seconds for facts on this machine.
These are single runs with a cached model, not controlled throughput measurements.

`examples.txt` retains exact leading results for three requests, including the
poor method-call match. The facts result for that request is a progress reporter's
`diagnostic` method. Repeated generic words such as "method", "written", and
"unresolved" may contribute, but this run does not isolate their effect. Extraction
also omits match-arm literal values from descriptions, losing useful evidence
about grammar names such as `field_expression`. Query 2 retrieves embedding code
before the processing checks. Precise provenance does not guarantee relevance.

Reproduce with the checkout's built binary and the model snapshot actually used
by its production cache:

```sh
cargo build
python3 benchmarks/retrieval/compare.py \
  --binary target/debug/mimirs \
  --model-snapshot /path/to/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-retrieval-comparison
```

The script creates temporary projects and preserves full CLI outputs in the
chosen output directory. `results.json` records this run's corpus, query, binary,
and model hashes. Reproduction with changed rendering or extraction is a new
experiment. Keep query preparation fixed when comparing document policies.

Next relevance work should test whether retaining selected literal evidence and
reducing repetitive clauses helps these failures, then use fresh requests to
check for regressions. Do not retune the existing queries or invent resolved
relations to improve scores.

A repeat after pinning the model revision and recording it in schema-7 metadata
is in `pinned-results.json`. It preserves every expected-file rank above and the
same model artifact hashes. The explicit parity test also checks every embedding
coordinate within `1e-6` and exact tokenizer configuration equality against the
previous loader. This verifies the loading change; it is not new relevance evidence.
