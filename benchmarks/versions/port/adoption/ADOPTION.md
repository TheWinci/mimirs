# Retrieval port adoption

The Rust port reproduces TS v2's top 20 source files on the original three development corpora. Kubernetes is deferred.

| Corpus | Queries | TS rank mismatches | R@5 | R@10 | R@20 | MRR@20 | Original Rust MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | 74 | 0 | 0.9797 | 1.0000 | 1.0000 | 0.8953 | 0.7917 |
| excalidraw | 72 | 0 | 0.9722 | 1.0000 | 1.0000 | 0.8299 | 0.7786 |
| django | 116 | 0 | 1.0000 | 1.0000 | 1.0000 | 0.9098 | 0.8189 |

All file rankings are compared per query in `adoption.json`. The source-tree, token-input, vector, and native ranking checks isolate the stages of the port. File labels do not establish answer correctness. Documentation segmentation and references use dedicated differential and exact-evidence fixtures.

| Corpus | Fresh s | Unchanged s | Edited s | Index MiB | Index peak MiB | Cold CLI median s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | 14.74 | 0.11 | 1.97 | 5.3 | 279.2 | 0.128 |
| excalidraw | 116.56 | 0.41 | 2.97 | 43.0 | 372.8 | 0.271 |
| django | 335.61 | 1.16 | 4.51 | 125.9 | 266.7 | 0.555 |

One development trial per corpus, cached model assets, fresh/unchanged/two-file-edit indexing and cold CLI queries. Some correctness checks ran concurrently. Descriptive costs, not isolated speedup claims.

Each run uses three workers and one inference thread per worker. Query timings include process and model startup. The two edited files are the largest files named by fixed query labels; the runner restores them before scoring. The JSON records hardware, cache scope, binary provenance, edit paths, index size, source coverage, displayed evidence checks, and every vector comparison.

Reproduce with `run.py --corpora mimirs excalidraw django --versions rust --repeats 1 --rust-limit 20` in a new root containing the port binary and original manifests. Collect without new inference using `port-adoption.py --root ROOT --reference-root TS_ROOT --output NEW_DIRECTORY`.

The final release binary reproduces all 262 saved CLI responses, excluding elapsed time, and reuses all 3,627 files with zero embedding calls. See `final-check.json`. Reproduce with `port-final-check.py --root ROOT --binary BINARY --output NEW_DIRECTORY`.
