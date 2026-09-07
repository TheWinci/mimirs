# ONNX Runtime threading and batching

Host: Apple M2 Pro, 10 logical CPUs, `macOS-26.6.2-arm64-arm-64bit-Mach-O`. Pinned model: `all-MiniLM-L6-v2-q8@751bff37182d3f1213fa05d7196b954e230abad9/tokenizer@751bff37182d3f1213fa05d7196b954e230abad9/ort@1.22.0`.

Test binary SHA-256: `f786da50fa73aaad543506602d4f0c80d4a4523720af85bfa78697f5e1f31547`. Input SHA-256: `11a0452c40bd7b29a3138591c046f5fe35b338892704aad6d7980ade0e3b7bc7`.

## Workload and timing

384 real windows: 128 each from Mimirs, Excalidraw, and Django. Capture reconstructs production window splitting and per-1024-document deduplication from retained published documents. It reproduces the full window populations of 1,572, 13,388, and 36,967. Selection uses evenly spaced token-length quantiles within each corpus. This gives equal corpus representation, not the weighting of a full indexing run.

Every candidate receives the same token IDs, attention masks, and type IDs. Inputs are sorted by length and grouped into batches before timing. Padding uses zero IDs, type IDs, and attention masks. Output vectors are restored to original input order and compared with singleton outputs from the production Model code.

Each configuration has 3 trials, with forward, reverse, and rotated execution orders. Each session is warmed with a short and a long input before timing. Session creation, tokenization, tensor construction, file reads, file writes, teardown, and profiling flushes are outside replay timing. Replay wall time includes worker dispatch and output pooling. Per-call runtime timers surround only Session::run. Timing trials have operator profiling disabled.

## Results

Sessions are independent simultaneous model calls. Intra-op threads parallelize work inside one call. Inter-op threads remain one and graph execution remains sequential. All candidates use Level3 graph optimizations and default thread-spinning behavior. The product of sessions and intra-op threads is a configured model-thread budget, not an OS CPU quota.

| Sessions | Threads/session | Batch | Model-thread budget | Median s | Range s | Windows/s | Speedup | Exact vectors | Max component difference | Peak MiB median |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 1 | 1 | 3 | 2.7078 | 2.7072-2.7106 | 141.81 | 1.000x | 384/384 | 0 | 214.5 |
| 1 | 1 | 1 | 1 | 7.7506 | 7.7384-7.7551 | 49.54 | 0.349x | 384/384 | 0 | 123.9 |
| 1 | 2 | 1 | 2 | 4.2872 | 4.2846-4.3071 | 89.57 | 0.632x | 384/384 | 0 | 121.8 |
| 1 | 3 | 1 | 3 | 3.1744 | 3.1717-3.1790 | 120.97 | 0.853x | 384/384 | 0 | 122.1 |
| 1 | 6 | 1 | 6 | 2.0983 | 2.0863-2.1219 | 183.00 | 1.290x | 384/384 | 0 | 124.3 |
| 4 | 1 | 1 | 4 | 2.0250 | 2.0196-2.4448 | 189.63 | 1.337x | 384/384 | 0 | 262.2 |
| 6 | 1 | 1 | 6 | 1.3775 | 1.3692-1.3875 | 278.77 | 1.966x | 384/384 | 0 | 365.6 |
| 3 | 2 | 1 | 6 | 1.5522 | 1.5298-1.5914 | 247.39 | 1.744x | 384/384 | 0 | 222.1 |
| 3 | 1 | 2 | 3 | 2.6562 | 2.6384-2.6683 | 144.57 | 1.019x | 0/384 | 0.0285954475 | 243.3 |
| 3 | 1 | 4 | 3 | 2.6738 | 2.6716-2.7099 | 143.62 | 1.013x | 0/384 | 0.0337877171 | 311.3 |
| 3 | 1 | 8 | 3 | 2.7977 | 2.7428-2.8052 | 137.25 | 0.968x | 0/384 | 0.0313256904 | 479.8 |
| 1 | 3 | 4 | 3 | 2.9049 | 2.8938-2.9081 | 132.19 | 0.932x | 0/384 | 0.0337877171 | 154.4 |

Exact vectors is the minimum number of byte-identical vectors across trials. Process peak RSS includes sessions, prebuilt tensors, initialization, and warmup. Raw runs also retain per-call mean/p95/max latency, total runtime-call duration, CPU seconds, padding counts, vector hashes, and minimum cosine similarity.

At no more than three configured model threads, the fastest sample-exact configuration was 3 sessions x 1 threads, batch 1: 2.7078 s, 1.000x the baseline throughput.

With the larger tested CPU budgets, the fastest sample-exact configuration was 6 sessions x 1 threads, batch 1: 1.3775 s, 1.966x the baseline throughput.

## Operator profile

A separate un-warmed run profiles 48 representative singleton inputs with one session and one thread. This trace is excluded from the performance comparisons. The table sums Node kernel_time events by operator type and excludes session startup and non-node events. These are instrumented event durations, not a direct allocation of the unprofiled sweep time.

| Operator | Events | Total ms | Node time share | Provider |
|---|---:|---:|---:|---|
| DynamicQuantizeMatMul | 864 | 416.052 | 39.309% | CPUExecutionProvider |
| MatMulIntegerToFloat | 864 | 131.932 | 12.465% | CPUExecutionProvider |
| BiasGelu | 288 | 107.866 | 10.191% | CPUExecutionProvider |
| FusedMatMul | 288 | 97.798 | 9.240% | CPUExecutionProvider |
| MatMul | 288 | 89.013 | 8.410% | CPUExecutionProvider |
| Softmax | 288 | 71.130 | 6.720% | CPUExecutionProvider |
| LayerNormalization | 624 | 60.584 | 5.724% | CPUExecutionProvider |
| Add | 2400 | 55.512 | 5.245% | CPUExecutionProvider |
| Transpose | 1152 | 18.996 | 1.795% | CPUExecutionProvider |
| DynamicQuantizeLinear | 288 | 4.812 | 0.455% | CPUExecutionProvider |
| Reshape | 1152 | 1.710 | 0.162% | CPUExecutionProvider |
| DequantizeLinear | 144 | 1.111 | 0.105% | CPUExecutionProvider |
| Gather | 192 | 1.106 | 0.104% | CPUExecutionProvider |
| Slice | 48 | 0.270 | 0.026% | CPUExecutionProvider |
| Cast | 48 | 0.152 | 0.014% | CPUExecutionProvider |
| Unsqueeze | 144 | 0.127 | 0.012% | CPUExecutionProvider |
| Shape | 48 | 0.097 | 0.009% | CPUExecutionProvider |
| Sub | 48 | 0.088 | 0.008% | CPUExecutionProvider |
| Mul | 48 | 0.069 | 0.007% | CPUExecutionProvider |

## Validation and limits

The sample reference is computed by the current production Model path. The ordinary test suite, batch token/mask/order checks, and Clippy passed before measurements. The model and tokenizer SHA-256 values match the pinned TS v2 fixtures. Each completed candidate checks finite outputs, component differences, cosine similarity, and byte equality against that reference.

This experiment changes no production settings. Sample equality is not full-corpus retrieval validation. Candidates that change vectors require quality evaluation and an explicit index-policy decision before adoption. Global length sorting has all sampled windows available in advance; a bounded indexing pipeline may not achieve the same batching efficiency. CPU contention, cache behavior, warmup, and longer sustained runs may change the ranking of candidates. No Kubernetes timing or speedup is inferred.

Retained artifacts: `/private/tmp/mimirs-onnx-runtime-sweep`. This includes the inputs, golden and candidate vectors, trial configurations, stdout/stderr, process timings, and raw operator traces.

Build the opt-in test binary with `cargo test --release --bin mimirs --no-run --message-format=json`; use its emitted executable path with `runtime-experiment.py --root NEW_ROOT --binary TEST_BINARY --projects RETAINED_PROJECTS`. Collect with `runtime-report.py --root NEW_ROOT --output OUTPUT_DIRECTORY`.

## Six-worker indexing validation

The winning singleton configuration was also exercised through the production indexing pipeline on all three complete development corpora. Only disposable project configurations set `embedding_workers = 6`; repository and user defaults were not changed. This is one validation trial per operation, not a paired speed comparison.

Production binary SHA-256: `1c7c9d83fc60d63dda524042b7db35ffc8f23060d831bbb5ea5c2daa135c1ba2`. Retained run: `/private/tmp/mimirs-staged-six-workers`.

| Corpus | Fresh s | Unchanged s | Edited s | Restore s | Fresh peak MiB |
|---|---:|---:|---:|---:|---:|
| mimirs | 8.423 | 0.128 | 1.301 | 1.308 | 433.2 |
| excalidraw | 56.467 | 0.642 | 2.214 | 2.087 | 599.4 |
| django | 151.635 | 1.945 | 3.907 | 3.897 | 429.2 |

All eleven published tables and all 27,295 stored document vectors match the three-worker reference byte for byte after identical edit/restore cycles. Fresh and incremental index runs completed without skipped files, unchanged runs made zero embedding calls, and staging stores were empty after completion. The full pipeline competes for CPU and memory alongside inference; its scaling need not match the isolated replay. Kubernetes remains unmeasured at six workers.

Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE --binary PRODUCTION_BINARY --workers 6`.
