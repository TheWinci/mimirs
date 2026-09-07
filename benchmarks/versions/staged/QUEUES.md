# Item queue residence

One diagnostic run per development corpus, with three inference workers and cached model assets. Fresh, unchanged, two-file edit, and restore runs are retained in `queue-residence.json`. All published tables and vector bytes match the retained reference after the same edit/restore cycle. These are measurements of the staged implementation with added instrumentation, not repeated speed comparisons.

Binary SHA-256: `e53fce62a5a3b8d3fba0156ec1da3f8ef2510da730dcde59420acc44bca89ccb`.

Raw profiles: `/private/tmp/mimirs-staged-queue-residence/results/<corpus>/<operation>-profile.json`.

## What the clocks measure

Channel clocks start only after a send is accepted and stop when the consumer dequeues the item. Producer blocking before acceptance and processing after dequeue are excluded. The admission gate records request-to-grant delay. Inference records each window separately from its file job submission until a worker dispatches it. Percentiles use nearest rank. Cancelled items that never dequeue are excluded.

Channel counts include the end marker. Writer messages include discovered/source/window/vector stages and file completion. The shutdown channel carries no items; its close wait is lifecycle coordination.

Prepared messages hold already-submitted jobs, so their queue time overlaps inference queue time and model work. Queue totals overlap across items and stages. They must not be added to wall time. Mean queued items is total item residence divided by profile wall time for these completed runs.

## mimirs

Fresh process wall time 12.922 s; profile interval 11.891 s. Inference workers spend 99.82% of their recorded active-plus-idle time inside model calls. The pre-staging profile was already 99.85%. Summed inference call time is 34.988 s, or 11.663 s divided among three workers. Mean model-call duration is 22.257 ms. This is a lower bound for the measured call costs at this worker count, not a prediction for faster kernels or additional workers.

| Queue or gate | Items | Mean ms | Median ms | p95 ms | Max ms | Mean queued items |
|---|---:|---:|---:|---:|---:|---:|
| Discovered paths | 81 | 4548.954 | 3325.817 | 10021.477 | 10259.595 | 30.99 |
| File admission gate | 80 | 133.148 | 77.358 | 419.707 | 755.368 | n/a |
| Parsed files awaiting window planning | 81 | 7.330 | 0.012 | 96.780 | 104.447 | 0.05 |
| Submitted jobs awaiting the merger | 81 | 662.385 | 601.348 | 1758.627 | 2181.170 | 4.51 |
| Windows awaiting an inference worker | 1572 | 886.412 | 788.341 | 2038.643 | 2308.883 | 117.18 |
| Messages awaiting the database writer | 401 | 0.269 | 0.009 | 1.202 | 11.938 | 0.01 |

The parser spends 10.652 s blocked on file admission. The window planner waits 10.032 s for input. The merger waits 11.667 s for inference completion. The database writer waits 11.319 s for messages, and its database work totals 0.431 s. Producers spend 0.000 s blocked by a full writer channel. These concurrent worker durations also overlap.

## excalidraw

Fresh process wall time 98.791 s; profile interval 98.576 s. Inference workers spend 96.70% of their recorded active-plus-idle time inside model calls. The pre-staging profile was already 99.11%. Summed inference call time is 285.414 s, or 95.138 s divided among three workers. Mean model-call duration is 21.319 ms. This is a lower bound for the measured call costs at this worker count, not a prediction for faster kernels or additional workers.

| Queue or gate | Items | Mean ms | Median ms | p95 ms | Max ms | Mean queued items |
|---|---:|---:|---:|---:|---:|---:|
| Discovered paths | 629 | 9759.304 | 8999.707 | 24991.703 | 27276.281 | 62.27 |
| File admission gate | 628 | 153.812 | 43.798 | 528.971 | 6691.583 | n/a |
| Parsed files awaiting window planning | 629 | 7.019 | 0.013 | 32.162 | 449.434 | 0.04 |
| Submitted jobs awaiting the merger | 629 | 634.354 | 391.566 | 1864.639 | 6274.623 | 4.05 |
| Windows awaiting an inference worker | 13388 | 1204.834 | 860.687 | 3932.421 | 6274.611 | 163.63 |
| Messages awaiting the database writer | 3141 | 0.686 | 0.012 | 3.943 | 18.857 | 0.02 |

The parser spends 96.594 s blocked on file admission. The window planner waits 89.614 s for input. The merger waits 95.191 s for inference completion. The database writer waits 93.677 s for messages, and its database work totals 4.421 s. Producers spend 0.000 s blocked by a full writer channel. These concurrent worker durations also overlap.

The conservative admission estimate also introduces isolated large-file work. Files whose reservation exceeds 32 MiB run alone. Their entire window plan is built before submission, leaving inference idle during that preparation.

| Isolated file | Source bytes | Reserved MiB | Window planning seconds |
|---|---:|---:|---:|
| `packages/excalidraw/subset/harfbuzz/harfbuzz-wasm.ts` | 789957 | 48.28 | 1.318 |
| `packages/excalidraw/subset/woff2/woff2-wasm.ts` | 972017 | 59.39 | 1.303 |

This supports a smaller scheduling opportunity: allow window production to feed inference incrementally within one oversized file, with bounded memory and unchanged deduplication and output vectors. It does not explain a multi-minute gap by itself.

## django

Fresh process wall time 278.728 s; profile interval 277.830 s. Inference workers spend 98.55% of their recorded active-plus-idle time inside model calls. The pre-staging profile was already 98.37%. Summed inference call time is 820.730 s, or 273.577 s divided among three workers. Mean model-call duration is 22.202 ms. This is a lower bound for the measured call costs at this worker count, not a prediction for faster kernels or additional workers.

| Queue or gate | Items | Mean ms | Median ms | p95 ms | Max ms | Mean queued items |
|---|---:|---:|---:|---:|---:|---:|
| Discovered paths | 2920 | 6014.387 | 5772.203 | 12713.486 | 18429.858 | 63.21 |
| File admission gate | 2919 | 92.453 | 14.503 | 399.433 | 6109.268 | n/a |
| Parsed files awaiting window planning | 2920 | 7.530 | 0.013 | 41.130 | 415.468 | 0.08 |
| Submitted jobs awaiting the merger | 2920 | 446.445 | 239.897 | 1584.581 | 6455.252 | 4.69 |
| Windows awaiting an inference worker | 36967 | 918.274 | 594.885 | 2835.709 | 6455.196 | 122.18 |
| Messages awaiting the database writer | 14596 | 3.883 | 1.167 | 14.571 | 74.774 | 0.20 |

The parser spends 269.870 s blocked on file admission. The window planner waits 255.940 s for input. The merger waits 272.536 s for inference completion. The database writer waits 252.744 s for messages, and its database work totals 23.028 s. Producers spend 8.935 s blocked by a full writer channel. These concurrent worker durations also overlap.

## Interpretation and limits

The long path and admission waits are backpressure from the bounded number of files in flight. The inference queue remains supplied while the model workers are busy. Moving waiting work farther downstream, or increasing queue capacity, does not itself increase model throughput. The baseline already overlapped preparation with persistent inference workers; additional stage separation therefore has little idle inference time to recover. The next throughput experiments should measure inference worker scaling and model-call cost while keeping retrieval parity explicit.

The completed fresh Kubernetes run had no profile. Its 1,219.085 s versus the previous 1,226.430 s is a 0.60% single-trial difference, not convincing evidence of a speedup. No per-item Kubernetes queue times can be reconstructed from those logs. The development profiles support an inference-throughput explanation, but do not directly measure fresh Kubernetes queues.

Profiling adds clock reads, reporting-lock acquisitions, and one f64 sample per dequeued item. Normal indexing does not read these clocks or retain samples. The diagnostic run does not isolate instrumentation overhead, and the historical profiles are not paired trials.

Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE --binary CANDIDATE`, then `staged-queues.py --root NEW_ROOT --output OUTPUT_DIRECTORY`. The collector performs no inference.
