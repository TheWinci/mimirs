# Collecting the whole index before embedding

Measured September 6, 2026, on the same Apple M2 Pro used for the version
comparison. This experiment uses the 1,251 saved Rust source chunks from the
80-file Mimirs corpus and a budget of three embedding CPUs. It changes when
chunks reach the model, while preserving their text and output order.

Collecting all chunks into one queue and retaining one chunk per model call
was fastest. Its three-run median was 28.45 seconds, versus 31.59 seconds for
the per-file reference, a 9.9 percent reduction in embedding time. This is an
embedding-only result; it does not establish an end-to-end indexing speedup.

| Embedding strategy | Work seconds | Trials | Peak RSS GiB |
| --- | ---: | ---: | ---: |
| Per-file, three single-chunk workers | 31.59 median | 3 | 0.65 |
| Whole-index queue, three single-chunk workers | 28.45 median | 3 | 0.64 |
| Whole-index call, internal batches of 32 | 74.50 | 1 | 2.46 |
| Length-sorted whole-index call, batches of 32 | 31.81 | 1 | 2.38 |
| Length-sorted whole-index call, batches of 128 | 37.22 | 1 | 6.50 |
| One model batch containing all 1,251 chunks | Stopped after 35.26 s | 1 interrupted | 8.25 sampled |

The last trial crossed the experiment's 8 GiB RSS limit and was terminated.
Its time is a lower bound, not a completed embedding measurement. RSS is sampled
at quarter-second intervals for the limit; completed runs use `/usr/bin/time`
for peak RSS. The process can exceed the limit between samples.

The input contains 268,553 token positions. Unsorted batches of 32 process
598,013 positions including padding. Length-sorted batches reduce that to
276,349. Sorting therefore removes most padding, but these tested batch settings
do not outperform the single-chunk queue. FastEmbed also retains token outputs
from the internal batches until pooling, which contributes to memory use when
all texts are passed in one call.

The queue and per-file reference produced bit-identical vectors. Batched output
differed by at most `1.64e-7` in any component. FastEmbed's mean pooling applies
the attention mask; the measurements show extra computation from padding without
a material change in these embeddings.

## Retrieval checks

Each of the five completed strategies was checked with all 74 original queries
through the production Rust CLI. The experiment updates only vector values in a
disposable copy of the index. Document IDs, vector row placement, source text,
lexical search, facts, relations, and query embedding behavior are preserved.
The reference vectors exactly match the retained production index.

All five strategies returned the same top twenty distinct-file rankings for
every query. Recall@10 was 0.9932, Recall@20 was 1.0, and MRR@20 was 0.8080.
That is 370 successful CLI searches. The interrupted whole-model-batch trial has
no retrieval result.

## Scope and reproduction

The corpus is historical Mimirs source at
`d40b90296ef770e6a3c0610eb4002fcabaae025e`; the retained Rust CLI is `35dd0d3`.
The model is the same float32 Qdrant MiniLM artifact and 512-token limit used by
production, with revision `5f1b8cd78bc4fb444dd171e59b18f3a3af89a079`.

Model startup, vector serialization, and diagnostic token counting are outside
the work timer. Collecting and sorting texts are inside it. Single-chunk modes
use three sessions with one ONNX thread each. Batched modes use one session with
three ONNX threads. The per-file reference calls the production worker-pool
function at each original file/256-document boundary, with models preloaded.
It supplies three worker slots even for the ten files with fewer than three
chunks; production limits slots to the number of chunks. Both modes retain the
same total CPU budget, but this is a standalone scheduling comparison rather
than a full replay of the production index command.

The fastest screening candidate and the reference received two more runs in
alternating order. Selection bias and one corpus limit generalization. Buffering
all analysis records, source snapshots, and pending writes in the actual indexer
would require separate memory and failure-recovery tests. Product indexing code
was not changed by this experiment.

```sh
python3 benchmarks/index/bulk.py \
  --project /tmp/mimirs-three-way/projects/mimirs-rust-0 \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-bulk-pilot

# Also attempt a literal single model batch, with the memory/time guard.
python3 benchmarks/index/bulk.py \
  --project /tmp/mimirs-three-way/projects/mimirs-rust-0 \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-bulk-pilot --resume --all-in-one

python3 benchmarks/index/bulk_search.py \
  --experiment /tmp/mimirs-bulk-pilot \
  --project /tmp/mimirs-three-way/projects/mimirs-rust-0 \
  --binary /tmp/mimirs-three-way/engines/mimirs-rust \
  --extension /path/to/sqlite-vec-0.1.9/vec0.dylib \
  --queries benchmarks/versions/queries/mimirs.json
```

[Timing and vector results](bulk-results.json) and
[per-query retrieval results](bulk-search-results.json) preserve the evidence.
Raw vectors, stdout, process measurements, and the disposable index are under
`/tmp/mimirs-bulk-pilot` on the measuring machine.

These batching results do not explain away Rust's larger indexing-time gap.
The next comparison should test model precision: the TypeScript engines use
quantized MiniLM weights, while Rust currently uses float32 weights. That is a
candidate to measure, not a demonstrated cause of the entire gap.
