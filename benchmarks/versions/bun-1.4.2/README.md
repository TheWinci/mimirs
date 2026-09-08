# Current Rust versus TS v2 on Bun 1.4.2

The [implemented search optimization](SEARCH.md) supersedes the Rust query
timings below. This page preserves the measurements before that change.

The [Django follow-up](DJANGO.md) expands this initial two-corpus comparison and
measures the database-validation cost behind Rust's growing CLI search latency.
The tables below preserve the initial Mimirs and Excalidraw measurements.

Measured September 8, 2026. Current Rust is preferable for the tested fresh and
incremental indexing workloads and peak indexing memory. File-search rankings
are identical. Query latency and index size are mixed, and this does not establish
full feature parity.

[Bun 1.4.2](https://bun.com/blog/bun-v1.4.2), released September 5, is the latest
stable release checked for this comparison. [Bun 1.4](https://bun.com/blog/bun-v1.4)
introduced the Zig-to-Rust rewrite. JavaScript still executes through
JavaScriptCore. Rewriting Bun does not compile Mimirs's TS application into native
Rust. The release's headline improvements are not Mimirs measurements.

## Measurements

Mimirs indexing values below are medians of three fresh trials per executable,
with engine order rotated each round. Excalidraw indexing values are a single
fresh trial per executable. CLI values are medians of 30 invocations per
engine/corpus, using ten fixed queries repeated three times, alternating engines.
All models were already cached. Lower costs are better.

| Metric | Mimirs TS / Bun 1.4.2 | Mimirs Rust | Excalidraw TS / Bun 1.4.2 | Excalidraw Rust |
| --- | ---: | ---: | ---: | ---: |
| Fresh index, seconds | 27.449 | 11.881 | 207.695 | 100.667 |
| Unchanged index, seconds | 0.221 | 0.140 | 0.749 | 0.539 |
| Two-file edit, seconds | 4.795 | 2.007 | 10.426 | 3.305 |
| Fresh index peak RSS, MiB | 999.0 | 264.7 | 1511.9 | 370.2 |
| Cold CLI search, milliseconds | 250.0 | 134.7 | 302.1 | 318.3 |
| Fresh index directory, MiB | 11.34 | 9.50 | 57.45 | 76.24 |

Disk sizes come from the first correctness trial immediately after fresh indexing,
including all files in `.mimirs`. They do not describe directory size after the
subsequent edit/restore/search sequence. Rust stores source snapshots and analysis
records as well as retrieval data. This comparison does not isolate which tables
cause its larger Excalidraw index.

Rust fresh indexing is 2.31 times faster on Mimirs and 2.06 times faster on
Excalidraw. Peak indexing RSS is 73.5% and 75.5% lower. Rust's Excalidraw CLI
median is 5.4% slower, and its fresh index directory is 32.7% larger.
The larger-corpus indexing measurements are descriptive single runs.

The TS persistent API measured 95.1 ms median on Excalidraw in one query pass.
That keeps the model loaded. No equivalent persistent Rust API was measured,
so it must not be compared as if it were the same workload as cold CLI search.

## What the Bun upgrade changed

These are same-session, rotating Mimirs trials with identical TS source,
dependencies, models, inputs, and three inference threads.

| Runtime | Fresh median seconds | Fresh range seconds | Edited median seconds | Peak RSS median MiB |
| --- | ---: | ---: | ---: | ---: |
| Bun 1.3.14 | 29.358 | 29.146–29.402 | 5.147 | 1243.1 |
| Bun 1.4.2 | 27.449 | 27.301–27.489 | 4.795 | 999.0 |
| Current Rust | 11.881 | 11.864–11.971 | 2.007 | 264.7 |

Bun 1.4.2 reduces fresh indexing time by 6.5% and peak RSS by 19.6% here.
The improvement is useful, but does not close the current indexing gap.
This measures the complete Bun-version change, not the isolated effect of Rust
versus Zig within Bun. Bun 1.3.14 was not freshly retested on Excalidraw.

## Quality and workload differences

All 708 input files were indexed. Rust and TS on Bun 1.4.2 return exactly the same
top-20 file ordering on all 146 fixed queries: 74 Mimirs and 72 Excalidraw. The new
TS rankings also match the retained Bun 1.3.14 rankings. Both achieve Recall@10
and Recall@20 of 1.0 on this suite. MRR@20 is 0.8953 for Mimirs and 0.8299 for
Excalidraw. These are filename labels, not an assessment of answer correctness.

All 8,650 source windows match by path/text identity and their vectors pass the
existing tolerance: maximum component error at most 1e-5 and cosine at least
0.999999. Observed worst component error is 1.05e-7. The controlled TS retrieval
reference also matches the retained fixture exactly after changing only Bun's
version metadata. Its exporter verified 163 source/manifest/lock files against
the pinned Git objects. All 20 initial TS CLI/API ranking checks pass.

These products perform different indexing work:

| Corpus | Source vectors, either engine | Additional TS fact vectors | Additional TS relation vectors |
| --- | ---: | ---: | ---: |
| Mimirs | 859 | 1108 | 1053 |
| Excalidraw | 7791 | 6883 | 4778 |

TS embeds separate fact and relation documents, which the current Rust source
indexing path does not. Their default observational search output does not change
the source-file ordering scored here. This explains why the results cannot be
called a language-only comparison. The native Rust pipeline also has different
scheduling and storage, so the cost of each difference has not been isolated.

The archived TS CLI exposes watch mode and index status; the current Rust CLI
exposes neither. This run measures source indexing and file search, not every TS
workflow. Django has since been measured in the linked follow-up. Kubernetes
was not rerun with Bun 1.4.2; its older parity report does not establish new
timing measurements.

## Provenance and reproduction

- Rust: `0e69ce986536a783a4025def82dc1c7024b16d9a`, `2.0.0-alpha.1`, built with
  `cargo build --release --locked`. Build succeeded. The copied binary hash is
  recorded in [results.json](results.json).
- TS v2: `122674c8bfbbc3549390743f51396c5f0e4e3537`, the archived implementation.
  Existing frozen dependencies were reused; only the Bun executable changed.
- Host: Apple M2 Pro, 10 logical CPUs, 32 GiB RAM, macOS 26.6.2.
- Both use the pinned quantized Xenova MiniLM model and matching tokenizer.
  Cached model hashes were rechecked before timing.
- TS uses three inference threads. Rust uses three workers with one inference
  thread each. This bounds inference concurrency, not total process CPU use.
- Commands run sequentially on the user's active desktop. No other benchmark,
  build, or vector verification was intentionally run during timed commands.
  These are local measurements, not a controlled hardware lab.
- Both request 20 file results. The legacy owner-result limit of 100 was not used.
- Corpora, queries, and two-file edits use the existing version-benchmark
  definitions. Original file bytes were restored before scoring.

The primary run used the existing runner with Bun 1.4.2 first on PATH:

```sh
python3 benchmarks/versions/run.py \
  --root /tmp/mimirs-bun-1.4.2-comparison \
  --corpora mimirs excalidraw --versions v2 rust \
  --repeats 1 --rust-limit 20
```

The root contains the isolated Bun download, copied current Rust executable,
links to the verified archived TS engine and frozen corpora, retained first
indexes, and every command's stdout/stderr/time output. The additional
`repeat-small.py` and `repeat-cli.py` scripts in that root call the same runner's
configuration and measurement functions. All nine additional indexing trials and
all 120 additional CLI timings are preserved in the durable JSON, together with
original trial timings, per-query rankings, vector checks, manifests, model
hashes, and binary provenance. Its command arrays identify exact invocations.
