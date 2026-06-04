# Benchmarks

Search quality on four real codebases (three languages, 72–120 stratified queries each), re-measured 2026-06-04 on the current pipeline: vector similarity + BM25 combined by reciprocal-rank fusion, identifier-aware FTS, weight 0.5. Each codebase is indexed fresh and queried with a fixed set of queries whose expected files are known.

**Metrics:** Recall@K (fraction of expected files in the top K), MRR (1 / rank of the first hit), Zero-miss (queries with no expected file in the top 10).

## Results

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| mimirs | TypeScript | 244 | 74 | **95.3%** | 0.759 | 4.1% |
| Excalidraw | TypeScript | 693 | 72 | **90.3%** | 0.773 | 9.7% |
| Django | Python | 3,181 | 116 | **97.4%** | 0.727 | 2.6% |
| Kubernetes | Go | 8,792 | 120 | **89.2%** | 0.689 | 10.8% |

MRR 0.69–0.77 means the first relevant file usually lands in the top few results. Recall stays strong as repos grow — 97–100% by top-20 everywhere — with the one consistent effect of scale being that a few correct files slip just past the top-10 on the largest repos (see the K-sweep below).

These query sets are deliberately non-saturated: each spreads roughly ⅓ easy / medium / hard across subsystems, so the benchmark can actually discriminate ranking changes rather than bottoming out at 100%. (The earlier 30-query-per-repo sets scored higher precisely because they were easier; the numbers here are lower and more honest.)

Corpora: mimirs is indexed on its own source (TypeScript `src/`, tests, benchmarks, and Markdown docs — 244 files); Excalidraw and Django are fresh clones (Django includes its tests + docs); Kubernetes is Go-only with tests/vendor excluded and generated files demoted. Every expected path was verified to exist in the indexed revision.

### Recall by K — why top-10 is the default

| K | mimirs | Excalidraw | Django | Kubernetes |
|---|---|---|---|---|
| 5 | 91.2% | 86.1% | 87.9% | 78.3% |
| 7 | 93.9% | 88.9% | 93.1% | 83.3% |
| **10** | **95.3%** | **90.3%** | **97.4%** | **89.2%** |
| 15 | 96.6% | 95.8% | 100% | 95.0% |
| 20 | 98.6% | 97.2% | 100% | 98.3% |

Top-10 captures most targets on small-to-mid repos. On the largest repos (Kubernetes at 8.8k files, and Excalidraw) structurally similar siblings push some targets to ranks 11–20, so `searchTopK: 15–20` is worth it there — each extra result adds ~150 tokens, negligible for an agent.

## Embedding model

Default: **all-MiniLM-L6-v2** (384-dim, ~23 MB ONNX, in-process, no API). Small, fast to index, strong on these benchmarks. Configurable via `embeddingModel` / `embeddingDim` / `embeddingPooling` / `embeddingDtype` (re-index required); the model is cached globally (`~/.cache/mimirs/models`), so it's a one-time download shared across projects.

We A/B'd larger code-aware models against the default:

| Model | Params | Dim | Index speed | Index size | Retrieval |
|---|---|---|---|---|---|
| **all-MiniLM-L6-v2** (default) | 23M | 384 | 1× | 1× | best here |
| gte-modernbert-base | 149M | 768 | ~6× slower | ~1.5× | no gain |
| arctic-embed-m-v2.0 | 305M | 768→256 | ~6× slower | ~1.5× | no gain |

The bigger models cost far more to index and store without improving retrieval on these codebases, so all-MiniLM stays the default. A/B one on your own repo with `benchmarks/model-ab.ts`.

## How the pipeline ranks

1. **Retrieve** — vector kNN (sqlite-vec) and BM25 (FTS5) in parallel. FTS is identifier-aware: compound identifiers are split (camelCase / snake_case), so `depends` matches `getDependsOn`.
2. **Fuse** — the two ranked lists are combined by reciprocal-rank fusion (weighted by `hybridWeight`, default 0.5), which is robust to their very different score scales.
3. **Re-rank** — source paths up / tests down, exact symbol-name hits injected, query↔filename affinity, dependency-graph centrality boost, generated/boilerplate files demoted.

Oversized chunks (>256 tokens) are split into overlapping windows, embedded, and merged into one vector at index time (`embeddingMerge`), so a large function's tail isn't lost to truncation.

## Reproduce

```bash
# index any directory + run a query file of { query, expected[] } entries,
# searching at top-20 and reporting the full recall@K sweep + MRR
bun benchmarks/rebench-full.ts <dir> benchmarks/<name>-queries.json 0.5

# example with a fresh clone
git clone --depth 1 https://github.com/django/django /tmp/django
bun benchmarks/rebench-full.ts /tmp/django benchmarks/django-queries.json 0.5
```

Kubernetes uses a Go-only config (exclude tests/vendor, demote generated), placed at `<repo>/.mimirs/config.json`:

```json
{ "include": ["**/*.go"],
  "exclude": ["vendor/**", "**/*_test.go", "test/**", "third_party/**", "hack/**"],
  "generated": ["applyconfigurations/**", "**/zz_generated*", "**/fake_*", "**/*_generated.go"] }
```

Query files: [mimirs](benchmarks/mimirs-queries.json) (74), [Excalidraw](benchmarks/excalidraw-queries.json) (72), [Django](benchmarks/django-queries.json) (116), [Kubernetes](benchmarks/kubernetes-queries.json) (120). The full K-sweep harness is [benchmarks/rebench-full.ts](benchmarks/rebench-full.ts).
