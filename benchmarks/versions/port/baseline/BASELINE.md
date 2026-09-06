# Retrieval port baseline

Frozen TS v2 reference and pre-port q8 Rust. Kubernetes is deferred.

| Corpus | Engine | R@5 | R@10 | R@20 | MRR@20 | Misses | Fresh s | Peak MiB | Timing trials |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | v2 | 0.9797 | 1.0000 | 1.0000 | 0.8953 | 0 | 29.13 | 1268 | 3 |
| mimirs | rust | 0.9392 | 0.9797 | 0.9932 | 0.7917 | 0 | 18.25 | 370 | 1 |
| excalidraw | v2 | 0.9722 | 1.0000 | 1.0000 | 0.8299 | 0 | 209.07 | 2045 | 3 |
| excalidraw | rust | 0.9167 | 0.9444 | 0.9722 | 0.7786 | 2 | 324.10 | 882 | 1 |
| django | v2 | 1.0000 | 1.0000 | 1.0000 | 0.9098 | 0 | 753.19 | 3148 | 3 |
| django | rust | 0.9655 | 1.0000 | 1.0000 | 0.8189 | 0 | 374.99 | 395 | 1 |

TS rows reuse the previous three-trial measurements. Rust rows use one
fresh, unchanged, and edited index trial per corpus, with cached model assets
and three embedding workers. These are descriptive baseline timings, not
isolated performance claims. Lightweight fixture capture and source inspection
took place during the Rust run; no second model workload ran concurrently.

All source manifests and restored working files were checked. TS raw rankings
were rescored and saved CLI/API samples verified. Rust saved source and
displayed evidence were audited. The JSON retains per-query file rankings,
identity/input hashes, validation summaries, and raw artifact locations.

The original queries label files, not answers. TS returns twenty files; the
pre-port Rust baseline returns up to one hundred owners and collapses those
to twenty files for scoring. This is not an equal candidate or output budget.
The two engines also differ in source windows and embedding policy.
