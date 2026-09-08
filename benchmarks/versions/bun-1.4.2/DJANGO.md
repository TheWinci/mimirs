# Django follow-up and Rust search scaling

The [implemented search optimization](SEARCH.md) supersedes the Rust query
timings below. This page preserves the measurements before that change.

The larger test supports the search-scaling concern. On Django, the current Rust
CLI takes 663 ms per search versus 441 ms for archived TS v2 on Bun 1.4.2. Rust
remains faster at indexing and uses less peak indexing memory. The clearest
search cost is repeated database-wide validation before retrieval.

The executable revisions, frozen dependencies, cached models, and host are the
same as the [initial comparison](README.md). Django is pinned to
`4bbc27c8686f10f9556cef02dbfa9f5157fbcf56`: 2,919 files, 19,173,107 source bytes,
18,645 source windows, and 116 fixed queries. No query or source was removed.

## Django results

| Measurement | TS v2 / Bun 1.4.2 | Current Rust |
| --- | ---: | ---: |
| Fresh index, seconds | 715.101 | 279.152 |
| Unchanged index, seconds | 3.495 | 1.808 |
| Two-file edit, seconds | 54.131 | 5.346 |
| Peak fresh-index RSS, MiB | 2383.4 | 270.0 |
| Fresh index directory, MiB | 237.12 | 234.74 |
| Cold CLI median, milliseconds | 441.2 | 663.1 |
| Recall@10 / Recall@20 | 1.000 / 1.000 | 1.000 / 1.000 |
| MRR@20 | 0.9098 | 0.9098 |

Fresh, unchanged, and edited indexing are single sequential trials, first Rust,
then TS. Search costs come from 30 invocations per engine: ten fixed queries
repeated three times, alternating engines. TS's three pass medians were
442.7, 441.9, and 439.6 ms; Rust's were 688.4, 658.5, and 663.3 ms.

The earlier Rust-only search pass in the same run measured 576.7 ms on the ten
sample queries. The later alternating run measured 663.1 ms. Access order and
cache state affect the result; the headline comparison uses the matched,
alternating repeats. Rust is slower than TS in both measurements.

Rust is 2.56 times faster for fresh indexing, about 10.1 times faster for this
two-file edit, and uses 88.7% less peak indexing RAM. These are product workloads,
not isolated language costs. TS also embeds 43,956 fact documents and 28,867
relation documents, in addition to the 18,645 source windows embedded by both.
Unlike Excalidraw, Django's fresh Rust index is slightly smaller than TS's.
There is no consistent Rust disk-size disadvantage across these corpora.

All 116 Django top-20 file rankings match exactly, including comparison with the
retained Bun 1.3.14 TS rankings. All 18,645 source windows match by path/text
identity, and their vectors pass the existing component-error and cosine
tolerances. All ten initial TS CLI/API comparisons pass. Across the three
corpora, that is 262 matching query rankings and 27,295 matching source-window
vectors. These checks do not establish answer correctness beyond filename labels.

## How search costs grow

| Corpus | Files | Source windows | TS CLI median ms | Rust CLI median ms | Rust / TS latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mimirs | 80 | 859 | 250.0 | 134.7 | 0.54 |
| Excalidraw | 628 | 7791 | 302.1 | 318.3 | 1.05 |
| Django | 2919 | 18645 | 441.2 | 663.1 | 1.50 |

Different languages, file structures, query sets, and returned evidence confound
a pure size-scaling curve. A separate Rust phase diagnostic identifies a concrete
cost that grows with the whole index.

## Rust phase diagnostic

A disposable release executable calls the existing production functions in the
same order as the CLI. It times database opening, subsequent policy checks, model
loading, query embedding, and retrieval with evidence. It returns file paths
instead of formatting source snippets. No production source was changed.

Each corpus uses the same ten queries, repeated three times, alternating the
probe with production TS CLI calls in the same order as the latency benchmark.
All 90 diagnostic rankings match the normal Rust CLI exactly.

| Median phase, milliseconds | Mimirs | Excalidraw | Django |
| --- | ---: | ---: | ---: |
| Database open and schema/integrity/FK validation | 13.17 | 103.95 | 321.94 |
| Model metadata and global policy/consistency checks | 2.69 | 27.85 | 78.28 |
| Model loading and tokenizer setup | 59.14 | 59.22 | 59.27 |
| Query embedding | 5.20 | 4.44 | 4.77 |
| Retrieval, ranking, and evidence construction | 36.76 | 102.71 | 173.46 |
| Total before output | 117.10 | 298.45 | 639.21 |

Each row is a median, so phase medians need not sum to the median total. Process
startup, final output, and process exit are outside these internal phase times.
These diagnostic totals are separate from the original CLI measurements.

The combined opening/validation median is 15.89 ms on Mimirs, 131.76 ms on
Excalidraw, and 400.29 ms on Django. The median per-invocation share of total
pre-output work is 13.6%, 44.7%, and 63.0%, respectively. Model loading stays
near 59 ms. Retrieval and evidence costs also grow, but database opening and
validation account for the larger part of Django's measured cost.

The code explains what this phase does:

- `commands::search::run_at` calls `storage::open_read_only` for every CLI query.
- [`validate_schema`](../../../src/storage.rs#L204) creates a reference schema,
  compares schema objects, runs `PRAGMA integrity_check`, and runs
  `PRAGMA foreign_key_check`.
- [`policy::read`](../../../src/storage/policy.rs#L43) then checks policies,
  file/snapshot coverage, per-file document counts, embedding/document links,
  and FTS/document coverage across the stored index.
- The archived TS read-only database initializer checks schema version and
  enables read-only query mode without those full integrity/FK scans.

The diagnostic measures these groups, not the individual SQL statements inside
each group. It establishes expensive opening/validation work on the query path;
it does not assign all 400 ms to `integrity_check` alone.

The next optimization to test is moving full-index audits out of every search,
while retaining schema/model checks and validation of the evidence actually
returned. This requires a deliberate validation policy. No optimized candidate
was tested, and subtracting 400 ms is not a measured future speedup.

## Reproduction and retained evidence

[results.json](results.json) includes all three corpora, source manifests,
per-query rankings, index timings, all repeated CLI timings, vector parity,
and the 90 diagnostic records with binary and probe-source hashes.

The Django run used the existing runner, with the isolated Bun 1.4.2 directory
first on PATH:

```sh
python3 benchmarks/versions/run.py \
  --root /tmp/mimirs-bun-1.4.2-comparison \
  --corpora django --versions rust v2 --repeats 1 --rust-limit 20
```

The raw logs and retained indexes remain in that root. `django-repeat-cli.py`
uses the same measurement helper for the alternating repeats.
[search-phases.rs](search-phases.rs) is the diagnostic entry point. To build it,
the unchanged production `src` tree was copied into a disposable crate, only its
`main.rs` was replaced with the probe, and the original dependencies and lockfile
were retained. The temporary crate is named `mimirs-search-phases`.
Its successful release build used:

```sh
CARGO_TARGET_DIR=/Users/winci/repos/mimirs/target \
  cargo build --release --locked \
  --manifest-path /tmp/mimirs-bun-1.4.2-comparison/probe/Cargo.toml
```

The phase driver is retained as [run-phases.py](run-phases.py). The production
working tree was checked for changes to `src`, `Cargo.toml`, and `Cargo.lock`
before copying. The comparison still uses Rust revision
`0e69ce986536a783a4025def82dc1c7024b16d9a` and the original release binary hash.
Kubernetes was not rerun. These measurements are on an active desktop, with
cached model files and sequential commands, not a controlled hardware lab.
