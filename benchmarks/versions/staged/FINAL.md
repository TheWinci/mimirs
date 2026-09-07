# Staged indexing measurements

The implementation separates discovery, parsing, window preparation, inference,
vector merging and database writes. One writer commits intermediate snapshots to
a separate staging database and publishes complete files atomically. It retains
three singleton inference workers and the accepted retrieval policy.

The measurements show no clear overall speed gain on the development corpora.
The earlier profile already showed little inference idle time. Intermediate
persistence adds CPU and database work, much of which overlaps inference.

## Repeated small-corpus comparison

Three rotating unprofiled fresh trials per executable use the same pinned Mimirs
corpus and cached assets. Timed commands run sequentially without competing work.

| Executable | Median fresh s | Trial range s |
| --- | ---: | ---: |
| baseline | 11.993 | 11.930–12.836 |
| scheduling | 11.873 | 11.853–12.790 |
| persisted | 11.980 | 11.931–12.808 |

All fresh published-table hashes match in all nine trials. The medians differ
by at most 0.12 seconds. [Raw trials](repeated.json) retain binary identities,
CPU and peak RSS. These repeats apply only to Mimirs; larger comparisons below
are single diagnostic runs and do not establish repeatable speed changes.

## Scheduling and persistence costs

| Corpus | Scheduling fresh s | Persisted fresh s | Persisted unchanged s | Edit s | Restore s |
| --- | ---: | ---: | ---: | ---: | ---: |
| mimirs | 12.914 | 12.941 | 0.134 | 1.987 | 1.983 |
| excalidraw | 97.214 | 98.253 | 0.510 | 3.736 | 3.137 |
| django | 273.385 | 277.981 | 2.321 | 5.174 | 5.210 |

These profiled trials use the exact same fixed two-file edits and restoration.
The [pre-separation profile](BASELINE.md), [scheduling checkpoint](SCHEDULING.md)
and [persistence checkpoint](PERSISTENCE.md) preserve the separate measurements.

| Corpus | Scheduling CPU s | Persisted CPU s | Scheduling RSS MiB | Persisted RSS MiB | Stage payload MiB | Peak staging disk MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | 36.340 | 36.450 | 261.906 | 254.781 | 4.694 | 0.938 |
| excalidraw | 290.280 | 295.650 | 359.203 | 377.594 | 39.471 | 3.169 |
| django | 841.220 | 858.660 | 268.750 | 262.859 | 130.974 | 2.501 |

Staging payload is serialized data, not physical device-write volume. Disk peaks
include the database and rollback journal. Rows are deleted as files publish.
All staging tables are empty after completion. Startup cleanup costs are inside
index timings; abandoned-run cleanup is also covered by interruption tests.
The raw profiles record stage active time, queue waiting, admission limits and
payload peaks. Thread times overlap and cannot be added to wall time.

## Correctness and scope

All 27,295 development vectors and all eleven audited published tables match
the accepted checkpoint after the same edit/restore cycle. The final executable
also matches all 262 accepted CLI responses, normalizing only elapsed time, and
reuses all 3,627 unchanged files without inference. See [final CLI checks](final-cli.json).

The larger persistence measurements use the persistence checkpoint executable.
The full-run executable adds source-hash and processing-identity validation plus
the interruption checks. Its hash is recorded in the repeated trials and Kubernetes
run. The corrected final executable also releases unused writer cache during
incremental publication. Its identity and exact comparisons are recorded in the
[cache correction](CACHE.md) and final CLI checks.

[Interruption checks](INTERRUPTION.md) cover stage commits, failed replacement,
writer exclusion, OS process termination and full-queue cancellation. Native and
fallback lifecycle tests pass with the real cached model. Automatic recovery
from saved intermediate stages remains deferred.

[The final Kubernetes run](kubernetes/KUBERNETES.md) records fresh indexing
separately from the entire runner and compares it with the accepted 1,226.430 s
checkpoint. Kubernetes was excluded from development iterations.

## Kubernetes and incremental correction

The single fresh Kubernetes index took **1,219.085 seconds, or 20 min 19 s**,
compared with the accepted 1,226.430 seconds. The roughly seven-second difference
is too small to call a meaningful speedup from single runs. The 11-minute target
remains open. The full Rust runner took 1,659.621 seconds, or 27 min 40 s.
All 8,790 files, 134,363 vectors, 120 CLI responses and 12,973 displayed evidence
spans pass exact comparison or source validation.

That full run exposed slower incremental reuse after writes. The subsequent
[paired incremental correction](CACHE.md) reduced median two-file edit time from
23.215 to 11.717 seconds and restoration from 22.123 to 10.774 seconds. The original
baseline medians in the same short comparison were 11.116 and 10.087 seconds.
All stored tables and vectors match after the same additional edit/restore cycle.
The correction preserves complete validation and leaves some incremental overhead.

The full-run timing belongs to the checkpoint before the cache correction.
Fresh indexing does not use the corrected cache-release branch. No second fresh
Kubernetes index was run; the correction was verified through short incremental
runs, exact stored-data comparisons, lifecycle tests and final CLI checks.
