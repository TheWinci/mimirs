# Stage measurements before separation

Three persistent inference workers, unchanged singleton inputs, cached model assets. One profiled fresh run per pinned development corpus. Exact published-table and vector-byte comparisons pass after the fixed edit/restore cycle. These are diagnostic measurements, not speedup claims.

| Corpus | Fresh wall s | Summed inference active s | Summed inference input wait s | Calls |
| --- | ---: | ---: | ---: | ---: |
| mimirs | 12.810 | 34.744 | 0.051 | 1572 |
| excalidraw | 94.946 | 281.117 | 2.535 | 13388 |
| django | 275.908 | 810.863 | 13.437 | 36967 |

Mimirs took 12.810 s with profiling and 11.813 s without it in one adjacent fresh run each. This is a descriptive overhead check, not an estimate with measured variance.

The model workers already spend most of their measured lifetime computing. More upstream overlap has limited opportunity to remove starvation on these corpora. Separate stages still allow direct measurement of preparation and storage stalls. Intermediate persistence must be measured separately because it adds work.

[Raw measurements](baseline-stages.json) retain the binary hash, stage counters, times, and command paths. Worker times overlap and cannot be added to process wall time. Raw per-file profiles and indexes remain under `/tmp/mimirs-staged-s1`.
