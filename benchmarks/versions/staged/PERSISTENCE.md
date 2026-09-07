# Intermediate persistence checkpoint

Changed files commit discovery, source/analysis, document/window mappings and
merged vectors to a separate staging database. One writer publishes each complete
file atomically in canonical order, then deletes its intermediate rows.

| Corpus | Fresh s | Unchanged s | Edited s | Restored s | Payload MiB | Peak staging MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mimirs | 12.941 | 0.134 | 1.987 | 1.983 | 4.694 | 0.938 |
| excalidraw | 98.253 | 0.510 | 3.736 | 3.137 | 39.471 | 3.169 |
| django | 277.981 | 2.321 | 5.174 | 5.210 | 130.974 | 2.501 |

All eleven published tables and all 27,295 vector byte sequences match the
baseline after the same fixed edit/restore cycle. Every unchanged run performs
zero inference calls. Staging contains zero work, source, window or vector rows
after every completed corpus.

Payload counts describe serialized intermediate data, not physical device writes.
Peak staging disk includes the database and its rollback journal. Queue metrics
and timings are in the [raw report](persistence.json). Single diagnostic trials
do not establish a repeatable speed change.

Checks cover durable out-of-order stages, conflicting generations and duplicates,
missing mappings, abandoned-stage cleanup, atomic replacement rollback, ordered
worker failure, writer failure, and source edits after reading. Standard tests,
Clippy and the release build pass. Raw profiles and indexes remain under
`/tmp/mimirs-staged-s5`.
