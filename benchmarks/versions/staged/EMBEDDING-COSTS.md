# Embedding call costs

One diagnostic run per pinned development corpus, with three single-threaded inference sessions, singleton model inputs, cached assets, and the existing quantized MiniLM model. No worker, batch, model, token-window, or inference optimization was applied.

Binary SHA-256: `1c7c9d83fc60d63dda524042b7db35ffc8f23060d831bbb5ea5c2daa135c1ba2`.

Raw profiles: `/private/tmp/mimirs-staged-embedding-costs/results/<corpus>/<operation>-profile.json`.

## Timer boundaries

- Tokenization covers encoding each submitted text, padding, and truncation.
- Input preparation covers validating padded lengths, building integer arrays, copying the attention mask, and constructing ONNX tensors.
- Runtime covers the synchronous `Session::run` call, including Rust/C binding overhead and internal runtime work. It does not isolate individual operators or pure matrix computation.
- Pooling covers output extraction, shape validation, masked mean pooling, and normalization with the existing float64/float32 rules.
- Cleanup releases output tensors, the retained mask, and token encodings after success. Input values consumed by `Session::run` are released within its runtime boundary.
- Other is outer inference-worker active time minus the five measured components. It includes validation, call transitions, and instrumentation overhead.

All values below are summed worker wall durations. The three workers overlap, so these values can exceed elapsed indexing time. Percentages use outer inference-worker active time as the denominator. Per-call averages use the measured singleton call count. Pre-submission window planning is reported separately and is not included in these percentages.

## mimirs

Fresh process elapsed time: 12.585 s. Profile interval: 11.586 s. 1,572 singleton calls; 34.131 s summed outer worker active time.

| Component | Worker seconds | Share | Mean ms per call |
|---|---:|---:|---:|
| Tokenization | 0.280529 | 0.822% | 0.178453 |
| Input arrays and tensors | 0.003954 | 0.012% | 0.002515 |
| ONNX Runtime call | 33.754620 | 98.897% | 21.472405 |
| Output extraction, pooling, normalization | 0.084116 | 0.246% | 0.053509 |
| Temporary buffer cleanup | 0.005717 | 0.017% | 0.003637 |
| Other and measurement overhead | 0.002306 | 0.007% | 0.001467 |

Pre-submission window planning (`embedding_prepare`): 0.755 s. Inter-window vector merging (`vector_merge`): 0.000758 s. These run outside the measured worker call and may overlap it.

## excalidraw

Fresh process elapsed time: 94.677 s. Profile interval: 94.475 s. 13,388 singleton calls; 273.649 s summed outer worker active time.

| Component | Worker seconds | Share | Mean ms per call |
|---|---:|---:|---:|
| Tokenization | 2.810399 | 1.027% | 0.209919 |
| Input arrays and tensors | 0.031091 | 0.011% | 0.002322 |
| ONNX Runtime call | 270.066757 | 98.691% | 20.172300 |
| Output extraction, pooling, normalization | 0.673819 | 0.246% | 0.050330 |
| Temporary buffer cleanup | 0.049182 | 0.018% | 0.003674 |
| Other and measurement overhead | 0.017813 | 0.007% | 0.001331 |

Pre-submission window planning (`embedding_prepare`): 7.661 s. Inter-window vector merging (`vector_merge`): 0.004386 s. These run outside the measured worker call and may overlap it.

## django

Fresh process elapsed time: 269.093 s. Profile interval: 268.208 s. 36,967 singleton calls; 792.120 s summed outer worker active time.

| Component | Worker seconds | Share | Mean ms per call |
|---|---:|---:|---:|
| Tokenization | 6.786852 | 0.857% | 0.183592 |
| Input arrays and tensors | 0.097136 | 0.012% | 0.002628 |
| ONNX Runtime call | 783.094232 | 98.861% | 21.183602 |
| Output extraction, pooling, normalization | 1.956879 | 0.247% | 0.052936 |
| Temporary buffer cleanup | 0.125525 | 0.016% | 0.003396 |
| Other and measurement overhead | 0.059421 | 0.008% | 0.001607 |

Pre-submission window planning (`embedding_prepare`): 18.503 s. Inter-window vector merging (`vector_merge`): 0.010814 s. These run outside the measured worker call and may overlap it.

## Combined fresh-call breakdown

51,927 calls, weighted by their measured worker time.

| Component | Worker seconds | Share |
|---|---:|---:|
| Tokenization | 9.877779 | 0.898% |
| Input arrays and tensors | 0.132180 | 0.012% |
| ONNX Runtime call | 1086.915609 | 98.819% |
| Output extraction, pooling, normalization | 2.714813 | 0.247% |
| Temporary buffer cleanup | 0.180424 | 0.016% |
| Other and measurement overhead | 0.079540 | 0.007% |

## Validation and limits

Measured call counts equal the existing embedding-call and worker-item counts for all twelve fresh, unchanged, edit, and restore runs. Unchanged runs have no model calls or component costs. All eleven published tables, including vector bytes, match the retained reference after the same edit/restore cycle. Staging stores are empty after completion.

The standard tests, a focused real-model comparison of instrumented parallel calls against unprofiled singleton calls, formatting, and Clippy passed before measurements. No builds, tests, or other inference benchmarks overlapped the timed commands.

This is a cost breakdown, not an optimization trial or a paired measurement of profiling overhead. Timers measure wall duration inside each worker, including descheduling and any runtime waits. The runtime bucket does not prove that every measured second is arithmetic. Kubernetes was not rerun; these numbers do not directly measure its cost distribution.

Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE --binary CANDIDATE`, then `staged-embedding-costs.py --root NEW_ROOT --output OUTPUT_DIRECTORY`. The collector performs no inference.
