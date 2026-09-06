# Single-chunk embedding experiment

Keep the existing tree-sitter documents, their order and their source evidence.
Vary the number of chunks passed to the embedding backend and ONNX intra-op
threads. No line-based documents or production defaults change.

```sh
python3 benchmarks/index/probe.py \
  --project /tmp/mimirs-index-profile/project \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-single-chunk-probe --single-chunks

python3 benchmarks/index/parallel.py \
  --single-results /tmp/mimirs-single-chunk-probe \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-parallel-chunk-probe

python3 benchmarks/index/compare_vectors.py \
  --project /tmp/mimirs-index-profile/project \
  --single-results /tmp/mimirs-single-chunk-probe \
  --parallel-results /tmp/mimirs-parallel-chunk-probe \
  --output /tmp/mimirs-chunk-vector-check
```

Run these commands sequentially with no other timing workloads. The first
command measures the current batches, then single chunks at 10, 1, 2, 4, 6 and
8 threads. It repeats the fastest single-chunk setting and current batches twice
more. Confirmation medians include each setting's screening run, so selection
bias and a small sample limit conclusions.

The second command creates persistent workers with an independent model session
per worker. Each call embeds exactly one chunk. The coordinator sends the next
chunk to the first available worker, restores document order, and waits for all
chunks in the current file batch before dispatching the next batch. The corpus
has at most 107 chunks per file, so each barrier is also a file boundary. Files
with more than 256 chunks would have additional barriers. There is no cross-file
pooling or waiting to collect similarly sized inputs.

A one-worker control measures queue overhead. The sweep tests workers/threads
per worker of 2/4, 4/2, 6/1 and 10/1. These use six to ten inference threads in
total; the first sweep covers the smaller thread budgets. The fastest setting gets
two additional runs. Startup is measured separately and includes loading every
worker's model. Multiple sessions also increase memory use. Thread counts are
runtime settings; these experiments do not pin work to physical CPU cores.

All trials use the same cached model and all 2,817 saved source documents from
the pinned Maturin corpus. Slower nonbaseline trials stop after at least 180
seconds. Reports preserve commands, executable/source/input hashes, timings,
vector hashes, maximum component differences and minimum per-document cosine
similarity against the batched reference. Vector serialization and diagnostic
token counting are outside the embedding timer. These are embedding measurements,
not full-index or installation times.

FastEmbed 6.0.2 passes an attention mask to ONNX and uses that mask in mean
pooling. Padding consumes computation but is excluded from the average. Changing
batch shapes can change floating-point rounding; vector comparisons test that
effect rather than assuming padding dilutes the embeddings.

## Results on 2026-09-06

Apple M2 Pro, 32 GiB RAM, six performance cores and four efficiency cores.
The OS schedules all work; no affinity or thermal controls were applied.

| One chunk per call, intra-op threads | Embedding seconds, screening run |
| ---: | ---: |
| 1 | 165.86 |
| 2 | 90.92 |
| 4 | 54.03 |
| 6 | 43.89 |
| 8 | 41.67 |
| 10 | 38.50 |

The three-run batched median was 78.87 seconds, ranging from 70.31 to 79.01.
The three-run single-chunk median at ten threads was 41.41 seconds, ranging
from 38.50 to 41.68. That is a 47.5 percent reduction in embedding time.
Each run used all 2,817 documents. Single-chunk calls process 525,449 token
positions, compared with 1,200,568 including padding for the existing batches.

Every completed single-chunk run had a maximum component difference of
`1.4901161193847656e-7` from the batched reference. The saved texts and input order
were identical. These results support a computational cost from padding, with
small rounding differences in the output, rather than embedding dilution.

| Parallel workers | Threads per worker | Embedding seconds, screening run |
| ---: | ---: | ---: |
| 1, queue control | 10 | 42.38 |
| 2 | 4 | 34.45 |
| 4 | 2 | 34.47 |
| 6 | 1 | 39.82 |
| 10 | 1 | 35.69 |

Two workers with four intra-op threads each had a three-run median of 35.05
seconds, ranging from 34.45 to 35.49. This reduces embedding time by 55.6 percent
against current batches and 15.3 percent against the single-worker median.
The two- and four-worker screening times are effectively tied. Two workers use
fewer model sessions; the experiment does not establish a unique optimum.

Every single-chunk configuration, including all parallel runs, produced
byte-identical vectors to the other single-chunk configurations. Their minimum
per-document cosine similarity to the batched reference was
`0.999999999999741`.

The 16 frozen, source-informed queries retained identical ordered top 40 and
top 256 document candidates in an offline cosine comparison. The largest query
score change was `1.8843190113804198e-7`. This checks ranking stability for these
queries; it does not rerun SQLite search, render evidence, or establish broader
retrieval quality. Document text and evidence come from the existing index and
were not rewritten.

[Raw results](single-chunk-results.json) include both sweeps, confirmation runs,
model hashes, hardware, commands and the query comparison. Full vectors and
temporary build files remain in `/tmp/mimirs-single-chunk-probe`,
`/tmp/mimirs-parallel-chunk-probe` and `/tmp/mimirs-chunk-vector-check`.

The eight-thread pool is a throughput result. The CPU-budget experiment below
addresses the user's preference to leave most of the machine available during
indexing. These probes do not change the indexer, its chunk policy or its stored
facts and relations.

## CPU budgets

```sh
python3 benchmarks/index/parallel.py \
  --single-results /tmp/mimirs-single-chunk-probe \
  --snapshot /path/to/model/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-cpu-budget-probe --cpu-budget
```

This mode uses `max(1, CPUs // 3)` and `max(1, CPUs // 2)` workers, with one ONNX
intra-op thread per worker. On this ten-core Mac those budgets are three and five.
`TOKENIZERS_PARALLELISM=false` keeps tokenization on the calling workers. All
workers still finish the current file before starting another. Each budget gets
three runs, with the order reversed in the middle repetition.

The runner measures child-process user and system CPU time with `getrusage`.
CPU seconds divided by process wall time gives average busy cores; dividing
again by the host's ten logical CPUs gives the reported machine percentage.
These whole-process averages include model startup and vector serialization,
but exclude compilation and the Python vector comparison. Embedding time still
excludes startup and serialization. They do not measure peak CPU usage or
interactive responsiveness, and a worker budget is not an OS-enforced CPU quota.

For production, apply the fraction to the whole pool using Rust's detected
available parallelism, with at least one worker. One-third is the proposed default
for the user's responsiveness preference; one-half can be an explicit faster
setting. A single-core machine cannot reserve two-thirds of its CPU with an
integer worker count alone. Measure full-index and incremental latency, session
memory and worker-failure cleanup before shipping the pool.

| Budget on this Mac | Workers, one thread each | Median embedding time | Median average machine CPU |
| --- | ---: | ---: | ---: |
| One-third, rounded down | 3 | 58.44 s | 26.55% |
| One-half | 5 | 42.16 s | 39.24% |

Both rows have three runs. Three workers ranged from 58.02 to 58.52 seconds;
five workers ranged from 40.10 to 42.36. The five-worker budget saves 16.28
seconds at the cost of about 13 more percentage points of average machine CPU.
Those percentages describe OS CPU-time accounting, not equal performance from
the performance and efficiency cores.

All six runs produced byte-identical vectors to the previous single-chunk
experiment, including the vectors used in the successful frozen-query check.
No additional ranking change follows from disabling tokenizer parallelism.
[CPU-budget results](cpu-budget-results.json) contain the six runs, CPU times,
input/output hashes and model provenance. Full artifacts remain in
`/tmp/mimirs-cpu-budget-probe`. These measurements preceded the integration below.

## Configured indexing

The indexer now accepts `embedding_workers = 3` as an absolute maximum in
`.mimirs/config.toml`. Omission selects one-third of available logical CPUs,
rounded down, with at least one worker. Explicit values clamp to available CPUs;
zero and non-integer values are invalid. Worker count is a runtime setting and
does not invalidate stored source documents or embeddings.

The backend loads model sessions lazily and reuses them. Scoped worker threads
take chunks as they become free and join before each submission returns, with
at most 256 documents per submission from the current file. Each model call
receives one chunk. This differs from the probe's persistent OS threads while
preserving its model reuse and file boundary. Failures cancel further work,
join workers and return no partial vector list. Search uses one worker for its
single query. Tokenizer parallelism is disabled to avoid another thread pool.

The release CLI passed a full check on the same Maturin corpus:

| Scenario | Effective worker limit | Process time, one run |
| --- | ---: | ---: |
| Fresh index, omitted setting | 3 | 66.48 s |
| Unchanged index, configured 10,000 | 10 | 0.30 s |
| Two edited files, configured one | 1 | 1.83 s |

The fresh run indexed 272 files and recorded 2,817 single-chunk model calls.
Source snapshots, facts, entities and retrieval documents matched the previous
index exactly. Stored vectors matched the single-chunk probe byte for byte.
All frozen CLI search ranks, visible-answer checks and evidence audits passed.
Changing the worker limit reused all 272 files; the incremental run rebuilt
only its two changed files. One RSS sample during fresh indexing was 577 MiB,
not a peak memory measurement.

[Integration results](configured-results.json) record these checks and source
hashes. The automated suite passed 170 tests, plus two explicit real-model
checks; Clippy passed with warnings denied. Full profiles and search output are
in `/tmp/mimirs-configured-index`. These single-run timings verify the
integration; they do not establish a new performance median.
