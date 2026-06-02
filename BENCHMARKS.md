# Benchmarks

Search quality on four real codebases (three languages, 30 queries each), re-measured 2026-06-02 on the current pipeline: vector similarity + BM25 combined by reciprocal-rank fusion, identifier-aware FTS, default weight 0.5. Each codebase is indexed fresh and queried with a fixed set of queries whose expected files are known.

**Metrics:** Recall@K (fraction of expected files in the top K), MRR (1 / rank of the first hit), Zero-miss (queries with no expected file in the top 10).

## Results

| Codebase | Language | Files | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|
| mimirs | TypeScript | 89 | **100.0%** | 0.883 | 0.0% |
| Excalidraw | TypeScript | 692 | **96.7%** | 0.900 | 3.3% |
| Django | Python | 3,113 | **96.7%** | 0.903 | 3.3% |
| Kubernetes | Go | 8,795 | **93.3%** | 0.759 | 6.7% |

MRR 0.76–0.90 means the first relevant file usually lands at or very near rank 1. Recall stays high as repos grow; the one consistent effect of scale is that a few correct files slip just past the top-10 on the largest repos (see the K-sweep below).

Corpora: mimirs is indexed on its own source (`src/` + docs); Excalidraw, Django, and Kubernetes are fresh clones (Django includes its tests + docs; Kubernetes is Go-only with tests/vendor excluded and generated files demoted).

### Recall by K — why top-10 is the default

| K | mimirs | Excalidraw | Django | Kubernetes |
|---|---|---|---|---|
| 5 | 98.3% | 93.3% | 96.7% | 90.0% |
| 7 | 98.3% | 96.7% | 96.7% | 93.3% |
| **10** | **100%** | **96.7%** | **96.7%** | **93.3%** |
| 15 | 100% | 96.7% | 100% | 96.7% |
| 20 | 100% | 96.7% | 100% | 100% |

Top-10 captures nearly everything on small-to-mid repos. On very large repos (Kubernetes, 8.8k files) structurally similar siblings push a few targets to ranks 11–20, so `searchTopK: 15–20` is worth it there — each extra result adds ~150 tokens, negligible for an agent.

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
# index any directory + run a query file of { query, expected[] } entries
bun benchmarks/rebench.ts <dir> benchmarks/<name>-queries.json 10 0.5

# example with a fresh clone
git clone --depth 1 https://github.com/django/django /tmp/django
bun benchmarks/rebench.ts /tmp/django benchmarks/django-queries.json 10 0.5
```

Kubernetes uses a Go-only config (exclude tests/vendor, demote generated):

```json
{ "include": ["**/*.go"],
  "exclude": ["vendor/**", "**/*_test.go", "test/**", "third_party/**", "hack/**"],
  "generated": ["applyconfigurations/**", "**/zz_generated*", "**/fake_*", "**/*_generated.go"] }
```

Query files (30 each): [mimirs](benchmarks/mimirs-queries.json), [Excalidraw](benchmarks/excalidraw-queries.json), [Django](benchmarks/django-queries.json), [Kubernetes](benchmarks/kubernetes-queries.json). The full K-sweep harness is [benchmarks/rebench-full.ts](benchmarks/rebench-full.ts).
