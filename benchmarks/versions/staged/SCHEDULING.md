# Separate stages before intermediate persistence

The parser, window planner, vector merger and SQLite writer now run independently
of one another. Three persistent inference workers retain the same singleton
inputs and deduplication boundaries. File reservations bound their shared queues.

| Corpus | Fresh s | Unchanged s | Edited s | Restored s |
| --- | ---: | ---: | ---: | ---: |
| Mimirs | 12.914 | 0.131 | 2.004 | 2.002 |
| Excalidraw | 97.214 | 0.504 | 3.749 | 3.067 |
| Django | 273.385 | 1.774 | 6.941 | 5.230 |

All eleven published tables and 27,295 vectors match the retained baseline after
the fixed edit/restore cycle. All 262 accepted CLI responses match after removing
only the elapsed-time line. Unchanged indexing performs zero inference calls.

These are single profiled diagnostic trials. Compared with the pre-separation
measurements, they show no substantial wall-time improvement. The inference
workers already had little idle time. Do not interpret a small difference here
as a repeatable speedup.

[Measurements](scheduling.json) retain CPU time, peak RSS, queue waits, payload
reservations, binary identity and corpus hashes. [CLI checks](scheduling-cli.json)
record the accepted response comparisons. Raw artifacts remain under
`/tmp/mimirs-staged-s4`. No intermediate persistence runs in this executable.
