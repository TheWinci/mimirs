# Four-corpus retrieval verification

The completed Rust retrieval port and language expansion reproduce TS v2's top-20 file rankings on all 382 original queries. No queries or corpus files were removed from the frozen suite.

| Corpus | Queries | Rank mismatches | MRR@20 | R@5 | R@10 | R@20 | Pre-port q8 Rust MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | 74 | 0 | 0.8953 | 0.9797 | 1.0000 | 1.0000 | 0.7917 |
| excalidraw | 72 | 0 | 0.8299 | 0.9722 | 1.0000 | 1.0000 | 0.7786 |
| django | 116 | 0 | 0.9098 | 1.0000 | 1.0000 | 1.0000 | 0.8189 |
| kubernetes | 120 | 0 | 0.7327 | 0.8667 | 0.9417 | 0.9667 | not run |

All 161,658 persisted source-window vectors pass the frozen TS comparison tolerance. Source-tree/window comparisons and exact-source audits pass. File labels measure retrieval, not whether a displayed answer is correct.

The [development adoption report](../adoption/ADOPTION.md) preserves the original three-corpus comparison and its per-query changes from pre-port q8 Rust. The [language checkpoint](../languages/README.md) verifies that the final release binary reproduces all 262 development CLI responses and retains the same analyses, documents, evidence and vectors. [Kubernetes](KUBERNETES.md) was run last with that same final binary; its JSON records all 120 ranking comparisons and measurements.

Timing scopes remain separate. The earlier three-corpus costs belong to the adoption build. The final Kubernetes trial measures the completed language build, with cached model assets and a three-thread inference budget. It records fresh, unchanged, edited and restored indexing, query costs, whole-run time, memory and index size. Different TS/Rust indexing work and warm-API/cold-CLI query workloads prevent a language-only speedup claim.

The implementation now includes 24 native languages, 26 grammars including dialects, Markdown sections and the remaining v1 formats through explicit text fallback. See [language support](../../../../docs/languages.md) for discovery rules, parser limits and reindexing instructions.
