# Three-version benchmark results

Measured on the same host with cached model assets and three embedding CPUs. See ../README.md for methodology.

| Corpus | Engine | R@5 | R@10 | R@20 | MRR@20 | Misses | Fresh s | Unchanged s | Edited s | CLI median ms | Warm median ms | Peak RSS MiB | Index MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| mimirs | v1 | 0.980 | 1.000 | 1.000 | 0.829 | 0 | 24.49 | 0.27 | 4.56 | 253.4 | 5.4 | 1491 | 11.4 |
| mimirs | v2 | 0.980 | 1.000 | 1.000 | 0.895 | 0 | 29.13 | 0.26 | 5.11 | 280.8 | 34.5 | 1268 | 14.3 |
| mimirs | rust | 0.953 | 0.993 | 1.000 | 0.808 | 0 | 34.40 | 0.13 | 4.30 | 155.8 | N/A | 677 | 6.8 |
| excalidraw | v1 | 0.889 | 0.931 | 0.986 | 0.768 | 1 | 185.07 | 0.47 | 5.12 | 260.6 | 11.4 | 6089 | 50.4 |
| excalidraw | v2 | 0.972 | 1.000 | 1.000 | 0.830 | 0 | 209.07 | 0.72 | 9.87 | 305.5 | 87.5 | 2045 | 63.0 |
| excalidraw | rust | 0.917 | 0.931 | 0.972 | 0.784 | 2 | 424.11 | 0.28 | 6.65 | 316.2 | N/A | 1287 | 42.2 |
| django | v1 | 0.983 | 1.000 | 1.000 | 0.818 | 0 | 625.75 | 2.41 | 8.94 | 320.1 | 43.6 | 4097 | 199.7 |
| django | v2 | 1.000 | 1.000 | 1.000 | 0.910 | 0 | 753.19 | 3.76 | 52.87 | 467.4 | 220.7 | 3148 | 241.3 |

Fresh/unchanged/edited values are medians of three independent trials. CPU, timing ranges, p95 values, coverage, and per-query results are in the JSON files. Warm timings exist only for the persistent TypeScript APIs. Rust file scores collapse up to 100 owner results; TypeScript requests 20 file results. These are different retrieval budgets.

Incomplete pairs: django/rust, kubernetes/v1, kubernetes/v2, kubernetes/rust

## Aggregate on corpora completed by all engines

Corpora: mimirs, excalidraw. Metrics are weighted by query count.

| Engine | Queries | R@10 | MRR@20 | Misses@20 |
|---|---:|---:|---:|---:|
| v1 | 146 | 0.966 | 0.799 | 1 |
| v2 | 146 | 1.000 | 0.863 | 0 |
| rust | 146 | 0.962 | 0.796 | 2 |

## Validation

- mimirs v1: 30 CLI/API ranking comparisons, 0 mismatches.
- mimirs v2: 30 CLI/API ranking comparisons, 0 mismatches.
- mimirs Rust: complete nonblank source coverage; 15,913 displayed source spans verified.
- excalidraw v1: 30 CLI/API ranking comparisons, 0 mismatches.
- excalidraw v1: 3 input files absent from the fresh index; paths are recorded in summary.json.
- excalidraw v2: 30 CLI/API ranking comparisons, 0 mismatches.
- excalidraw Rust: complete nonblank source coverage; 14,902 displayed source spans verified.
- django v1: 30 CLI/API ranking comparisons, 0 mismatches.
- django v1: 610 input files absent from the fresh index; paths are recorded in summary.json.
- django v2: 30 CLI/API ranking comparisons, 0 mismatches.

Only filenames have gold labels. Source fidelity checks do not score answer correctness. Model download time is excluded.
