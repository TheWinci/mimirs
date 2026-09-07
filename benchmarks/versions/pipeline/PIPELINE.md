# Persistent indexing workers

Persistent embedding threads and bounded file read-ahead reduced fresh indexing wall time on all three development corpora. The worker budget remains three singleton inference calls at a time. This experiment did not rerun Kubernetes. Its last measured fresh index remains 1,620.49 seconds, and the 11-minute target is still open.

| Corpus | Trials per binary | Before s | After s | Less wall time |
| --- | ---: | ---: | ---: | ---: |
| mimirs | 3 | 13.981 | 12.260 | 12.3% |
| excalidraw | 1 | 114.785 | 97.095 | 15.4% |
| django | 1 | 333.023 | 276.239 | 17.1% |

Mimirs reports medians from three trials per binary with alternating execution order. Excalidraw and Django each have one before/after trial, so their gains are descriptive results without a variance estimate. All runs use the original pinned source manifests and queries, cached model assets, fresh disposable indexes, and profiling enabled. Timings include process startup. No other tests or model runs overlapped the timed index commands.

The host is an Apple M2 Pro with 10 logical CPUs, 32 GiB memory, and macOS 26.6.2 on arm64. The coordinator can use CPU while the three inference threads run, so the worker setting is not an OS CPU quota.

| Corpus | Before CPU s | After CPU s | Before peak MiB | After peak MiB | Queue peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| mimirs | 36.33 | 36.15 | 255.1 | 262.2 | 0.94 |
| excalidraw | 295.82 | 294.69 | 413.0 | 367.7 | 4.61 |
| django | 849.89 | 846.07 | 264.5 | 260.6 | 2.47 |

CPU seconds sum user and system time. The table uses medians where there are repeated trials. Similar total CPU work with lower elapsed time is consistent with keeping the workers busy between files. This experiment combines persistent threads and file read-ahead; it does not isolate their individual contributions. Peak RSS varies, and these samples do not establish a general memory reduction.

At three workers, the coordinator queues at most six files. It pauses preparation when estimated retained source, document, input, and vector payload reaches 32 MiB. A further large file can exceed that threshold. Queue payload excludes allocator overhead and analysis metadata; it is not total process memory. Every fresh run of the new binary reached six queued files and stayed below the payload threshold.

| Corpus | Unchanged before / after s | Two-file edit before / after s | Restore before / after s |
| --- | ---: | ---: | ---: |
| mimirs | 0.134 / 0.133 | 2.002 / 1.979 | 2.005 / 1.971 |
| excalidraw | 0.504 / 0.494 | 3.054 / 3.025 | 3.112 / 3.035 |
| django | 1.693 / 1.785 | 5.090 / 4.983 | 5.053 / 4.990 |

Incremental checks have one trial per binary and run after the fresh measurements for that corpus. Unchanged indexing performs no inference. Edits and restoration each reindex exactly the two fixed files selected by the original benchmark. The small differences here should not be treated as reliable incremental speedups.

## Correctness

All fresh trials produce identical ordered rows and bytes across 11 stored tables, including source snapshots, chunks, documents, owner links, processing metadata, and vector storage. Both binaries also produce identical storage after the edit/restore cycle. The three restored indexes contain 27,295 document vectors. The report retains per-table SHA-256 hashes for those restored indexes. Fresh equality was asserted before each trial continued.

One fresh index of each corpus totals 51,927 singleton model calls with either binary. Token-window planning, 1024-document deduplication boundaries, merging, model assets, and index policy remain unchanged. This is a scheduling change and does not require rebuilding unchanged files.

All 262 public CLI search responses match the retained retrieval-port responses exactly after normalizing only elapsed time. The check includes ranking, formatting, and displayed source evidence. No TS rerun or new Kubernetes quality check was performed.

Tests cover cross-file concurrency, ordered vector results and commits, cancellation, inference errors and panics, and preservation of earlier commits and later stored files after failure. The full standard test suite, both explicit real-model language lifecycle tests, formatting, and Clippy pass.

## Profiling and reproduction

Each file has its own coordinator profile. Its wall time includes queued time and can overlap other files. `embedding_prepare` measures input planning and submission; `embedding_wait` measures only the coordinator waiting for results. Background inference also runs during preparation and saving, so wait time cannot be compared directly with the previous synchronous embedding phase.

Use [pipeline.py](../pipeline.py) with retained pinned corpora and a copy of the preceding release binary. The root must be new. The script checks corpus integrity, storage equality, cache state, and incremental behavior.

```sh
python3 benchmarks/versions/pipeline.py \
  --root /tmp/mimirs-pipeline-comparison \
  --reference-root /tmp/mimirs-three-way \
  --before /path/to/preceding/mimirs \
  --after target/release/mimirs \
  --corpora mimirs excalidraw django --repeats 3
```

This pilot used three repeats for Mimirs and one for each larger corpus to keep iteration time short. Raw commands, timing samples, profiler counters, hashes, and retained run paths are in [comparison.json](comparison.json). Exact CLI checks are in [final-check.json](final-check.json). The baseline release SHA-256 matches the [last Kubernetes checkpoint](../port/kubernetes/KUBERNETES.md). Both binary hashes are recorded in the comparison.
