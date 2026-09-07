# Kubernetes retrieval checkpoint

Rust and TS v2 return identical top-20 file rankings for all 120 original queries.

| Engine | MRR@20 | R@5 | R@10 | R@20 | Fresh s | Unchanged s | Edited s | Restore s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v2 | 0.7327 | 0.8667 | 0.9417 | 0.9667 | 2681.03 | 8.87 | 125.59 | 124.73 |
| rust | 0.7327 | 0.8667 | 0.9417 | 0.9667 | 1620.49 | 4.90 | 9.99 | 10.19 |

| Engine | Query processes s | Measured total s | Index MiB | Fresh peak MiB | Cold CLI median s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v2 | 160.77 | 3100.99 | 690.4 | 4508.7 | 1.330 |
| rust | 383.68 | 2029.25 | 971.0 | 337.3 | 3.037 |

One sequential trial per engine, TS then Rust, cached model assets and fresh indexes. A source-only Rust extraction check ran during TS indexing. Descriptive timings, not isolated performance measurements. Totals sum measured subprocesses and exclude copying, runner overhead and correctness audits. TS queries use 120 warm API calls plus warmup and 10 cold CLI samples; Rust uses 120 cold CLI calls. These totals are different workloads, not a speedup comparison.

The pinned corpus has 8,790 Go files. All 439,458 non-gap source chunks and 134,363 windows match TS. All 134,363 persisted vectors pass the frozen tolerance. Maximum component error is 1.19e-07; minimum cosine is 1.000000000000. Ten TS CLI samples match its API. Every Rust stored input and displayed source span passes the exact-source audit.

Host: Apple M2 Pro, 10 logical CPUs, 32 GiB memory, macOS-26.6.2-arm64-arm-64bit-Mach-O. Both engines use three inference threads in total. The JSON records the binary hash, revisions, unchanged corpus/query hashes, all rankings, phase CPU times, index coverage, and evidence counts.

TS v2 also embeds fact and relation documents during indexing. Its default search retrieves these perspectives without fusing them into source rankings. Rust ports the source-ranking path; its index has a different workload and representation. Timing and index-size differences therefore do not isolate implementation language.

The 11-minute target remains a performance follow-up. The reported friend's result has no verified matching workload or machine. The pre-port q8 Rust Kubernetes baseline was not run. File-label recall does not score answer correctness.

Run `run.py --root ROOT --corpora kubernetes --versions v2 rust --repeats 1 --rust-limit 20` after the three development corpora and language checks. Extract the saved Rust snapshots using the ignored `source_stage_report` probe, then collect with `port-kubernetes.py --root ROOT --source-report SOURCE_JSON --output NEW_DIRECTORY`. Collection performs no inference.

Observed wall time for the whole two-engine runner, including source copies and runner overhead: 5147 seconds, measured within two seconds. This is separate from the per-engine subprocess totals above.
