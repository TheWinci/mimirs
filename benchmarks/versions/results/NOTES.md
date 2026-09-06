# Interpretation and checks

These observations cover the completed Mimirs pilot and the first Excalidraw
indexing checks. Consult `summary.json` for the current set of completed pairs.
Do not treat missing rows as zero scores.

On the 74-query pilot, v2 has the highest MRR, 0.895. Rust scores 0.808 and
v1 scores 0.829. All engines reach full file recall at twenty results. Compared
with v2, Rust places the first expected file earlier on three queries, later
on sixteen, and at the same rank on fifty-five. The largest gaps include the
benchmark-threshold CLI command and the vector/BM25 database search helpers.
`rank-comparisons.json` records every paired rank.

Rust's median fresh index is slower on this pilot: 34.40 seconds versus 24.49
for v1 and 29.13 for v2. Its CLI search median is lower, 155.8 ms versus 253.4
and 280.8 ms. These CLI samples include startup and are distinct from warm
search in a running TypeScript process. Rust uses about half the peak resident
memory and index disk space here. A broader conclusion needs the larger
corpora; this is a small TypeScript source tree with identifier-heavy queries.

Rust stores 1,251 source retrieval vectors on the pilot. v1 stores 1,033 chunk
vectors, including derived parent chunks. v2 stores 859 source-window vectors,
1,108 fact vectors, and 1,053 relation vectors. Different inputs, model artifacts,
precision, and search budgets prevent attributing these differences to Rust
versus TypeScript alone.

All thirty sampled CLI rankings match the corresponding production API
rankings for each TypeScript engine. Rust's pilot audit verifies complete
nonblank source coverage, exact saved source ranges, and 15,913 displayed
source spans. This checks fidelity, not answer correctness. The original gold
labels identify files, not answer spans.

The first Excalidraw v1 run under the final protocol indexes 625 of 628 files.
It skips two large base64 WebAssembly source wrappers and an empty `.d.ts` file.
None is an expected answer. Its unchanged pass reports one indexed file:
`packages/excalidraw/components/canvases/index.tsx` remains stored with an empty
hash and no chunks. This behavior is included in the measured unchanged time.
The controlled edit test changes two queried files, but v1 reports three
indexed files because it also reprocesses that unchanged barrel file.

No product code or ranking parameters were changed during this comparison.
The superseded initial Excalidraw edit-protocol measurements are excluded.
Model/package download time is not included, so these are not first-install
latency measurements.

The user stopped the long comparison after the completed Mimirs, Excalidraw,
and TypeScript Django runs. Rust Django completed two full index trials and
its query measurements; those are preserved in `django-rust-partial.json`.
The third Rust Django fresh index was interrupted and is excluded. Kubernetes
was not run. Both the benchmark runner and its restart supervisor were stopped.
