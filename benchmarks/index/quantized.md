# Quantized MiniLM experiment

Q8 reduces full indexing time by 48% on the Mimirs pilot, with a measured
retrieval-quality cost. The three-run median falls from 35.30 to 18.34 seconds.
Peak resident memory falls from 669 to 376 MiB. Q8 is now the alpha default;
model configuration is deferred. These results cover one corpus.

Measured September 6, 2026, on an Apple M2 Pro with 32 GiB RAM. All variants use
three embedding workers, one ONNX thread per worker, one chunk per model call,
and the existing per-file indexing loop. The frozen input is 80 TypeScript
source files, producing 1,251 chunks, with 74 original benchmark queries.

| Model artifact | Fresh index median | Range | Embedding median | Peak RSS | MRR@20 | Recall@10 | Recall@20 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current Qdrant float32 | 35.30 s | 34.88 to 35.95 s | 32.67 s | 669 MiB | 0.8080 | 99.32% | 100% |
| Xenova float32 control | 34.55 s | 34.53 to 35.50 s | 31.78 s | 669 MiB | 0.8080 | 99.32% | 100% |
| Xenova q8 | 18.34 s | 18.28 to 18.35 s | 15.73 s | 376 MiB | 0.7917 | 97.97% | 99.32% |

The two float32 exports produce bit-identical document vectors and identical
file rankings. The control supports attributing the large speed difference to
quantization rather than a different underlying embedding model. Compared with
the Xenova float32 control, q8 reduces full index time by 46.9%.

The q8 artifact is 21.91 MiB, versus 86.20 MiB for float32. Downloads are excluded
from these cached-model timings. Stored retrieval vectors still have 384 float32
components; this experiment does not quantize the vector index itself.

## Retrieval tradeoff

Q8 improves the first expected file's rank on five queries, regresses it on nine,
and ties it on sixty. All 74 queries still return at least one expected file
within the top twenty distinct files, but the full top-twenty ordering changes
on every query.

One multi-target query loses a secondary expected file:
`startServer registerAllTools MCP stdio transport`. The server implementation
moves from rank three to two, while `src/cli/commands/serve.ts` moves out of the
top twenty from rank fourteen. This explains how Recall@20 drops while the
number of queries missing every expected file remains zero.

The largest first-hit regressions include the `search_conversation` hybrid
search tool and the wiki command dispatcher, both moving from rank one to two.
The `search_commits` tool moves from rank two to four. Every paired query and
returned file list is retained in [the results](quantized-results.json).

Q8 vectors differ from float32 by up to 0.04015 in a component. Their minimum
per-document cosine similarity to float32 is 0.98298; the mean is 0.99158.
This is a larger change than the rounding differences in the batching test.

## Controls and validation

The experiment builds an isolated copy of the Rust CLI at
`35dd0d3e76eeb4b936edd4e9e064314e7e250300`. Its model
loader accepts a benchmark-only, checksum-verified ONNX override and gives each
artifact a distinct model identity. Indexing and querying use matching weights.
The experiment itself does not modify the production source or release binary.

All variants use the current Qdrant tokenizer files and Rust's 512-token limit.
The shared tokenizer vocabulary hash also matches Xenova's. Chunk text, evidence,
order, and source input hashes match across all nine fresh indexes. The experiment
keeps the Rust ranking parameters and result limit fixed; it does not reproduce
the TypeScript engines' 256-token windowing or their ranking policies.

The q8 graph uses dynamic quantization. Every inference call contains one chunk,
so this test does not combine it with the preceding bulk-batching experiment.

Validation checks completed:

- Nine fresh indexes and nine unchanged indexes. Every unchanged pass reused all
  eighty files and indexed zero files.
- All 1,251 vectors are deterministic across the three repeats of each variant.
- All three variants completed 74 production CLI searches each, 222 total.
- A float32 query against the q8 index fails the model-identity check and leaves
  the index untouched.
- An incorrect ONNX checksum is rejected before inference.
- Every timing profile reports completion, three embedding workers, 1,251
  single-chunk calls, and no downloaded model assets.

Full-index timings include startup, parsing, chunking, model loading, embedding,
storage, and progress output, with profiling enabled. Variant order rotates
across the three timing rounds. Embedding phase timings exclude separately
recorded model startup and asset loading. Quality is measured on the first round;
vector hashes verify identical outputs in the later repeats.

Median unchanged-index times are 129 ms for current float32, 168 ms for the
Xenova float32 control, and 114 ms for q8. Median CLI search times across all
74 queries are 155, 194, and 138 ms respectively. The override variants verify
the model checksum on load; that extra work is included and is more expensive
for the larger float32 artifact.

Q8 is now the default. During alpha development, the measured indexing-time
and memory reductions outweigh the retrieval regression on this pilot.
This remains one historical TypeScript corpus; broader quality is unmeasured.
Changing precision requires re-embedding documents and using the same model
for queries. The experiment enforces that separation with model identities.

## Reproduce

```sh
python3 benchmarks/index/quantized.py \
  --output /tmp/mimirs-quantized-pilot \
  --corpus /tmp/mimirs-three-way/corpora/mimirs \
  --queries benchmarks/versions/queries/mimirs.json \
  --extension /path/to/sqlite-vec-0.1.9/vec0.dylib

python3 benchmarks/index/quantized_report.py \
  --experiment /tmp/mimirs-quantized-pilot \
  --extension /path/to/sqlite-vec-0.1.9/vec0.dylib \
  --output benchmarks/index/quantized-results.json
```

Requires the cached pinned Qdrant float32 artifact and Xenova float32/q8 artifacts,
macOS, Cargo dependencies already cached, and the frozen corpus prepared by the
version-comparison scripts. The runner verifies all three model hashes before
starting. The isolated binary uses a separate build target name.

[Summary and paired query results](quantized-results.json) include model,
executable, source, query, and input hashes. [Raw run reports](quantized-runs.json)
contain timings, exclusive profiles, counters, model metadata, and quality data.
The generated source patch, command logs, and disposable indexes remain under
`/tmp/mimirs-quantized-pilot` on the measuring machine.
