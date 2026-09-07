# Independent preparation workers

One reader/parser and one document/window worker feed the existing three
singleton inference workers. File reservations follow shared data through all
queues, capped at six admitted files and a 32 MiB estimated payload target.
A file above the target runs alone.

| Corpus | Fresh s | Unchanged s | Edited s | Restored s |
| --- | ---: | ---: | ---: | ---: |
| Mimirs | 13.077 | 0.134 | 1.970 | 1.966 |
| Excalidraw | 98.062 | 0.500 | 3.706 | 3.046 |
| Django | 276.285 | 1.775 | 6.936 | 5.082 |

All eleven published tables, including all 27,295 vector byte sequences, match
the retained baseline after the same edit/restore cycle. Unchanged runs make
zero inference calls. These single profiled trials establish correctness and
stage measurements, not a speedup claim.

[Measurements](preparation.json) identify the measured executable and pinned
inputs. Raw profiles and disposable indexes remain under
`/tmp/mimirs-staged-s3`. The commit also adds per-channel reservation-byte
accounting; this accounting-only addition follows the measured executable.
