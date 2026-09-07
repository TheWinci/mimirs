# Kubernetes after persistent workers

Fresh indexing took 1226.43 seconds, down from 1620.49 seconds. This saves 394.06 seconds, or 24.3% of elapsed time. The 11-minute target remains open.

| Operation | Previous s | Persistent workers s |
| --- | ---: | ---: |
| fresh | 1620.490 | 1226.430 |
| unchanged | 4.897 | 6.885 |
| edited | 9.988 | 9.806 |
| restore | 10.191 | 10.025 |

| Cost | Previous | Persistent workers |
| --- | ---: | ---: |
| Fresh user + system CPU seconds | 3878.970 | 3820.210 |
| Fresh peak RSS MiB | 337.312 | 331.859 |
| All 120 cold CLI queries, seconds | 383.682 | 382.639 |
| Ten fixed cold CLI samples, median seconds | 3.037 | 3.010 |
| Index MiB | 971.043 | 971.043 |

One new Rust trial compared with the earlier accepted Rust trial on the same host and corpus. Cached model assets, three inference workers, unprofiled fresh indexes. Timed fresh, unchanged, edited, restored indexes and all 120 cold CLI queries run sequentially. Correctness audits are outside measured commands. The baseline was retained, not rerun alongside the candidate.

Both runs use the pinned 8,790-file corpus on the same Apple M2 Pro with 10 logical CPUs and 32 GiB memory. The new binary retains three singleton inference workers and allows at most six pending files. Coordinator work can overlap inference, so this is not a hard CPU quota.

All 134,363 stored document vectors and the other rows in the 11 audited tables are byte-identical after the same edit/restore cycle. This covers source snapshots, chunks, document text, owner links, processing metadata, and vector storage. All 120 CLI responses match exactly after normalizing only elapsed time. The unchanged verification performs no inference. The source evidence audit also passes.

The previous checkpoint already matched TS v2 rankings and passed the source/vector checks. This run compares against that retained Rust checkpoint; it does not rerun TS. File-label retrieval scores do not measure answer correctness.

Fresh indexing improved substantially in this trial while total CPU work changed little. Unchanged indexing was slower in this sample; edited and restored indexing stayed close to the earlier times. These are single trials from separate runs, so small timing differences and memory differences should not be generalized.

The Rust runner took 1638.09 seconds including corpus copying, four index commands, all 120 search commands, and collection of their results. The additional storage and evidence audits are excluded from that time.

The [JSON report](kubernetes.json) records binary hashes, revisions, manifest/query hashes, exact table hashes, quality results, timings, and the evidence audit. The [previous checkpoint](../../port/kubernetes/KUBERNETES.md) and [development-corpus experiment](../PIPELINE.md) retain their original measurements.

To reproduce, copy the candidate binary to a new runner root as `engines/mimirs-rust`, link its `corpora` directory to the retained pinned corpora, and record the binary and host provenance. Run `run.py --root ROOT --corpora kubernetes --versions rust --repeats 1 --rust-limit 20`. Record whole-run wall time separately as `runner-wall.json`. Then collect without repeating inference using `pipeline-kubernetes.py --root ROOT --reference-root PREVIOUS_ROOT --output NEW_DIRECTORY`.
