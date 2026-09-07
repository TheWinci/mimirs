# Incremental reader regression and correction

The complete Kubernetes run exposed a regression in the staged checkpoint:
editing and restoring two files each took about 22 seconds. The following reuse
checks dominated the extra time. The profiled diagnostic attributed about 14.6
seconds to reuse validation and only 0.01 seconds to intermediate stage writes.

Reopening the reader and changing its open mode did not help. Releasing unused
writer cache after a committed publication brought reuse validation back to about
3.4 seconds. SQLite implements `PRAGMA shrink_memory` through
`sqlite3_db_release_memory`; it changes cache residency, not stored data or the
validation performed. The exact low-level cache interaction was not further isolated.

The correction applies only when indexing starts with existing files. Fresh
indexing and fully unchanged runs do not release writer cache. All snapshot,
document, evidence and vector-presence checks remain intact.

## Paired short runs

Each candidate uses a disposable copy of the same complete Kubernetes index.
Two alternating trials per candidate each perform the fixed two-file edit and
restoration. These runs perform no fresh indexing. Timed commands run sequentially.

| Candidate | Median edit s | Median restore s |
| --- | ---: | ---: |
| baseline | 11.116 | 10.087 |
| before | 23.215 | 22.123 |
| after | 11.717 | 10.774 |

The correction removes the large regression. The staged pipeline retains some
incremental overhead compared with the original baseline. All eleven published
tables and all 134,363 vector byte sequences match after the same additional
edit/restore cycle on every copy. The [raw comparisons](cache-release.json)
retain each timing, CPU, RSS, binary identity and stored-table hash.

The [single fresh Kubernetes run](kubernetes/KUBERNETES.md) belongs to the staged
checkpoint before this correction. Its original incremental timings are retained
there. No second fresh Kubernetes run was performed.
