# Index timing check

Use a release build and a clean Maturin checkout at
`479658ad9bce22c6e4955b2e47182111c166e37c`, with the fresh root-only `target`
exclusion in its mimirs config.

```sh
cargo build --release
python3 benchmarks/index/profile.py \
  --binary target/release/mimirs --project /path/to/maturin \
  --cache /path/to/mimirs/models --output /tmp/mimirs-index-profile
```

The output directory must be new. The script copies the 272 tracked supported
source files and model cache into that directory. It preserves the original
checkout and user cache. Profiles, logs, commands, hashes, and raw results remain
in the output directory. Report metadata identifies hardware, binary, source,
model assets, configuration, and relevant thread environment settings.

Three cached fresh-index runs with profiling alternate with three without it.
Each iteration also measures unchanged and fixed two-file incremental indexing,
both with redirected progress and with a drained pseudo-terminal. A separate
fresh-index terminal run checks inference-progress output. A final empty-model-
cache run measures asset acquisition separately from local processing. It does
not flush the OS filesystem cache or pretend one download is a stable network
benchmark. Index process times exclude copying, fingerprint checks, compilation,
and repository cloning.

Every run fingerprints snapshots, analysis, documents and vectors. Profiling
on/off and terminal/redirected runs must produce identical saved content for
each source state. Unchanged runs must embed nothing, and incremental runs must
rebuild exactly the two edited files. The edits are fixed trailing comments in
`src/lib.rs` and `maturin/__init__.py`. Restore the baseline before each run.

Timing reports contain exclusive phase totals. Per-file timings describe the
same work from another view and must not be added to the phase totals. Report
serialization is outside the reported phase wall time but inside the measured
process time. The backend embedding phase includes internal tokenization,
inference and pooling. FastEmbed 6.0.2 uses batches of at most 256 for this model,
matching mimirs' call limit, and configures ONNX intra-op threads from available
parallelism by default. See the pinned Cargo.lock for dependency versions.

## Release baseline on 2026-09-06

[Results](results.json) were collected on an Apple M2 Pro with 10 available CPU
threads and 32 GiB RAM. The corpus has 2,817 documents across 272 source files.

| Scenario | Runs | Median process time | Range |
| --- | ---: | ---: | ---: |
| Fresh index, cached model, profiling | 3 | 84.91 s | 83.31 to 91.61 s |
| Fresh index, cached model, no profiling | 3 | 85.44 s | 82.17 to 85.93 s |
| Unchanged index | 3 | 0.343 s | 0.337 to 0.351 s |
| Two edited files | 3 | 2.255 s | 2.134 to 2.314 s |
| Fresh index, terminal progress | 1 | 84.03 s | single run |
| Fresh index, empty model cache | 1 | 89.66 s | single run |

Profiling overhead is not distinguishable from the variation in these runs.
Terminal unchanged and incremental medians were 0.310 and 2.173 seconds; this
small sample does not establish a terminal speed advantage. Saved content was
identical across profiling and output modes for each source state.

Median exclusive costs for a fresh cached index were 80.13 seconds in embedding,
2.90 in chunk construction/token limits, 0.85 in analysis, and 0.61 in storage.
Embedding accounted for 94.4 to 94.9 percent of profile wall time in all three
runs. Asset reads and session startup together took under 0.11 seconds in these
cached runs. Progress output took about 0.01 seconds. Optimizing parsing or SQL
alone cannot remove most of the wait on this corpus.

The empty-cache run acquired five model files, 91,102,069 bytes, in 4.78 seconds.
That phase includes lookup/download and local asset reads. The network was the
host's existing connection with uncontrolled bandwidth. It is one observation,
not a forecast for another user's connection. `init` normally prepares these
assets before `index`; this experiment moves acquisition into the measured
index process. Package installation and compilation were not timed.

The previous 156-second development-build run is not a before/after performance
comparison. This slice adds measurements and leaves indexing defaults unchanged.

## Isolating embedding work

The optional probe builds a separate executable from
[embedding_probe.rs](embedding_probe.rs). It uses the same model, text, per-file
batches, maximum input length, pooling, and default runtime options. It does not
change mimirs or its saved index. Run it after the index experiment, without
other timing workloads running:

```sh
python3 benchmarks/index/probe.py \
  --project /tmp/mimirs-index-profile/project \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-embedding-probe --sample
```

`--sample` uses macOS `sample` in a separate run, excluded from timing comparisons.
Omit it elsewhere. The probe compares default, one, and four intra-op threads.
It preserves vectors for comparison and bounds slower trials by a timeout.
`--resume` can continue an unchanged experiment directory after interruption.
These are isolated single-run diagnostics, not full-index optimization results.

## Recommended optimization

The isolated default-thread trial took 81.93 seconds for embedding, consistent
with the index phase measurements. Four threads took 114.40 seconds and produced
identical vectors. The one-thread trial was stopped after more than four minutes;
it had already exceeded the default substantially, and no completed vector
comparison is available for that trial. Lowering the thread count is not supported
by these observations on this host.

The five-second stack sample places 402 of 406 main-thread samples under ONNX
session execution, with matrix multiplication prominent in the sampled calls.
Thread samples are not additive wall-time percentages. The sample is from a
separate diagnostic run and is excluded from the timing comparisons.

Across the 252 existing embedding calls, 525,449 actual token positions expand
to an estimated 1,200,568 positions after each batch is padded to its longest
input. That is 2.28 times the actual token count, with 56.2 percent of positions
used for padding. The estimate uses the model tokenizer after timed inference;
it adds no token-counting pass to the production indexer.

The next optimization to test is length-aware batching within each file:
partition or group its complete documents by token count, embed comparable
lengths together, and restore document order before saving. Preserve the current
per-file invalidation and commit behavior. Start within files so the experiment
does not need cross-file buffering, different failure semantics, or a new cache.

Embedding accounts for about 80 seconds of the current median first-index
budget. Removing all other measured work would save less than five seconds.
The padding ratio identifies avoidable input work, but cannot predict a wall-time
speedup because attention costs, batch sizes and scheduling also matter.

Use a 20 percent median fresh-index improvement as the initial validation target,
with three release runs on the same corpus and a second workload with large
functions. Compare incremental and unchanged times too. Reject a change that
loses source, changes saved document text/evidence, breaks partial-failure cleanup,
or materially changes the frozen retrieval results. Compare resulting vectors
with a stated numeric tolerance; changed padding can change floating-point
rounding. Smaller batches may increase call overhead, and other CPUs may behave
differently. This recommendation has not been implemented or measured as an
end-to-end speedup.

[Search verification](search-results.json) audits the index produced by the
profiled run. Saved document hashes, all frozen owner ranks, visible answer
checks, and per-block evidence match the prior mixed-project retrieval baseline.
[Embedding probe results](embedding-results.json) preserve the completed trials,
the interrupted single-thread observation, and the separate sampled run.
