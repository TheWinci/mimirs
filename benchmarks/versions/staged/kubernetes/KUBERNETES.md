# Kubernetes with staged indexing

Fresh indexing took 1219.085 seconds, compared with 1226.430 seconds at the accepted persistent-worker checkpoint. The 11-minute target remains open.

| Operation | Previous s | Staged s |
| --- | ---: | ---: |
| fresh | 1226.430 | 1219.085 |
| unchanged | 6.885 | 7.929 |
| edited | 9.806 | 22.069 |
| restore | 10.025 | 22.028 |

| Cost | Previous | Staged |
| --- | ---: | ---: |
| Fresh user + system CPU seconds | 3820.210 | 3851.910 |
| Fresh peak RSS MiB | 331.859 | 372.750 |
| All 120 cold query processes, seconds | 382.639 | 385.462 |
| Published index MiB | 971.043 | 971.094 |

All 8,790 files, 134,363 vector byte sequences and the other rows in the eleven audited published tables match. All 120 CLI responses match after removing only elapsed time. The evidence audit passes. Unchanged indexing reuses every file without inference, and staging contains no remaining work.

One new Rust trial compared with the earlier accepted Rust trial on the same host and corpus. Cached model assets, three inference workers, unprofiled fresh indexes. Timed fresh, unchanged, edited, restored indexes and all 120 cold CLI queries run sequentially. Correctness audits are outside measured commands. The baseline was retained, not rerun alongside the candidate.

The complete Rust runner took 1659.621 seconds, including corpus copying, fresh/unchanged/edit/restore indexing and all search commands. Storage and evidence audits ran afterward.

These are individual runs at different times. Their elapsed times do not establish a repeatable speedup. Both use cached assets and three singleton inference workers on the Apple M2 Pro. The staging pipeline preserves the model, inputs, merging and retrieval policy.

[Raw evidence](kubernetes.json) retains binary identities, timings, exact table hashes, query comparisons and source checks. [Development measurements](../FINAL.md) separate scheduling from intermediate persistence. [The previous checkpoint](../../pipeline/kubernetes/KUBERNETES.md) records the 1,226.430-second baseline.

The full-run table above preserves the original measured checkpoint. Its slower
incremental phases were investigated afterward. [Paired incremental checks](../CACHE.md)
show the corrected writer-cache behavior, with median edit/restoration times of
11.717/10.774 seconds and exact published-data parity. No second fresh Kubernetes
index was run. The final CLI validation uses the corrected executable.
