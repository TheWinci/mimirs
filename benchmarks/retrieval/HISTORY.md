# Historical Rust retrieval comparisons

The September 5, 2026 comparison keeps raw retrieval as the default. Facts
produce precise entity locations and source evidence, but these five requests
show two regressions and one improvement in expected-file rank.

| Request | Raw file rank | Initial facts rank | Current facts rank |
| --- | ---: | ---: | ---: |
| Stop batches when progress fails | 1 | 1 | 1 |
| Reuse complete unchanged output | 5 | 6 | 8 |
| Reject unknown database schemas | 1 | 1 | 1 |
| Record written method-call receivers | 2 | 14 | 4 |
| Remove deleted-file vectors | 2 | 1 | 1 |

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

These are historical experiments from the implementation that supported multiple
retrieval modes. Their saved JSON reports identify the corpus, query, model, and
binary hashes. The current binary has one source-chunk strategy; use the
[current check](README.md) to reproduce that path. The original source experiment
was uncommitted, so its binary hash alone is not a source revision.

Next relevance work should test whether retaining selected literal evidence and
reducing repetitive clauses helps these failures, then use fresh requests to
check for regressions. Do not retune the existing queries or invent resolved
relations to improve scores.

A repeat after pinning the model revision and recording it in schema-7 metadata
is in `pinned-results.json`. It preserves every expected-file rank above and the
same model artifact hashes. The explicit parity test also checks every embedding
coordinate within `1e-6` and exact tokenizer configuration equality against the
previous loader. This verifies the loading change; it is not new relevance evidence.

`closure-results.json` records the final renderer correction. Extracted closure
scopes now prevent bodies inside wrapped arguments or chained callees from
entering call descriptions. Written method names and nested call occurrences
remain. This changes inputs in 17 corpus files and reduces documents from 343
to 338. With unchanged queries, raw ranks remain 1, 5, 1, 2, 2; current facts
ranks are 1, 8, 1, 4, 1. Raw therefore remains the default. The original results
and examples above remain available to distinguish the measured representations.

## Raw source chunks

`source-results.json` compares `retrieval = "source"` with both existing policies
using the same source revision, model, and five prepared queries. Source mode
preserves complete small items, adds file and enclosing type/module context, and
splits oversized items on lines with a repeated signature. All non-whitespace
source is retained, including operators, literals, and macro bodies.

| Request | Raw line rank | Facts rank | Source chunk rank |
| --- | ---: | ---: | ---: |
| Stop batches when progress fails | 1 | 1 | 1 |
| Reuse complete unchanged output | 5 | 8 | 7 |
| Reject unknown database schemas | 1 | 1 | 1 |
| Record written method-call receivers | 2 | 4 | 1 |
| Remove deleted-file vectors | 2 | 1 | 1 |

Source used 246 vectors, compared with 338 facts documents and 2,585 raw lines.
Indexing took 11.41 seconds for source, 26.47 for facts, and 12.35 for raw lines
in this single cached-model run. These timings are descriptive, not controlled
performance claims. Exact leading source hits for four requests are retained in
`source-examples.txt`; reproduction exports every input and records its hash.

The receiver result now contains the actual `field_expression` match arm and
the `receiver` and `method` recording calls. The reuse query still ranks save
code before the completeness checks. Source improves two file ranks over raw,
regresses one, and ties two. It improves two ranks over facts and ties three.

The result supports trying source chunks, not declaring a general winner. This
still measures file discovery on the same five development requests. It does not
measure evidence sufficiency or isolate the effects of text, chunk boundaries,
prefixes, and result grouping. Raw lines remain the default; source is opt-in.
