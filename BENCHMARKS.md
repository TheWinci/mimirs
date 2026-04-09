# Benchmarks

Search quality benchmarks measured on four codebases. Last updated 2026-04-09.

**Metrics:** Recall@K (fraction of expected files in top-K), MRR (1/rank of first hit), Zero-miss (queries with no expected file in results).

## Results

All results use hybrid search (70% vector / 30% BM25) with pipeline improvements (source/test path boost, symbol expansion, dependency graph boost, doc expansion, filename affinity boost, boilerplate demotion). Default top-K is 10.

### mimirs (97 files, 30 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **98.3%** | **0.683** | **0.0%** |

### Excalidraw (693 files, 30 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **96.7%** | **0.442** | **3.3%** |

Excalidraw is a stress test — a large monorepo with 693 indexed files across `packages/`, `excalidraw-app/`, `dev-docs/`, and `examples/`. MRR is lower than the smaller codebases because heavily-imported utility files have many consumers that score competitively, pushing the source definition lower in rank. One math utility (`polygon.ts`) doesn't land until top-20, crowded out by element files that use the same geometric vocabulary.

### Django (3,090 files, 30 queries)

The mid-scale test — Django's full codebase (Python) with all files indexed including tests and docs. 3,090 files, 85k chunks.

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **93.3%** | **0.688** | **6.7%** |

Django is harder than Excalidraw despite having fewer source files because test `models.py` files (dozens of them) share the same vocabulary as Django's core `models.py`, and docs extensively reference the same settings and middleware names as the source. Two queries miss at top-10: `auth/models.py` gets buried by test model files, and `middleware/security.py` loses to docs that discuss the same HSTS/SSL settings. Both land by top-15.

### Kubernetes (8,553 files, 30 queries)

The scale test — the full Kubernetes codebase (Go), excluding test files and vendor/. 8,553 source files (including generated).

| Config | Recall | MRR | Zero-miss |
|---|---|---|---|
| **Excl. tests + generated demotion** | **90.0%** | **0.589** | **10.0%** |
| Excl. tests only (before pipeline v2) | 65.0% | 0.320 | 35.0% |
| Including test files (11,193 files) | 65.0% | 0.272 | 35.0% |

All measured at default top-10. The 3 queries that miss at top-10 all land by top-15, pushed down by structurally similar siblings (e.g. `chain.go` among dozens of `admission.go` plugins, `csi_plugin.go` among other volume plugins). Setting `searchTopK: 15` brings recall to 100%.

**Recommended Kubernetes config:**

```json
{
  "include": ["**/*.go"],
  "exclude": ["vendor/**", "**/*_test.go", "test/**", "third_party/**", "hack/**"],
  "generated": ["applyconfigurations/**", "**/zz_generated*", "**/fake_*", "**/*_generated.go"],
  "searchTopK": 15
}
```

**Impact of excluding test files:** Removing 2,640 test files eliminated 57,753 chunks (28%), shrunk the DB by 34% (521→344 MB), and cut index time by 37% (62→39 min). Test files contain the same domain vocabulary as source files, creating ranking noise without adding navigational value.

**Indexing performance:**

| Metric | With tests | Without tests |
|---|---|---|
| Files indexed | 11,193 | 8,553 |
| Chunks | 207,598 | 149,845 |
| DB size | 521 MB | 344 MB |
| Index time | 62 min | 39 min |
| Search latency (per query) | ~337 ms | ~230 ms |

### Scaling behavior

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| mimirs | TypeScript | 97 | 30 | 98.3% | 0.683 | 0.0% |
| Excalidraw | TypeScript | 693 | 30 | 96.7% | 0.442 | 3.3% |
| Django | Python | 3,090 | 30 | 93.3% | 0.688 | 6.7% |
| Kubernetes | Go | 8,553 | 30 | 90.0% (100% @15) | 0.589 | 10.0% (0% @15) |

93–98% recall at default top-10 across all codebases, with a clear scaling pattern: recall decreases as codebase size grows, from 98% at 97 files to 90% at 8.5k files. All codebases reach **100% at top-20**. At Kubernetes scale, `searchTopK: 15` is sufficient for 100% recall with proper configuration (test exclusion, generated file demotion). The 5 extra results add ~750 tokens per query — negligible for agents that routinely consume thousands of tokens per tool call.

### Why top-10?

We benchmarked at K=5, 7, 10, 15, 20 across all four codebases to find the diminishing-returns point.

| K | mimirs (30q) | Excalidraw (30q) | Django (30q) | Kubernetes (30q) | Extra tokens vs K=10 |
|---|---|---|---|---|---|
| 5 | 95.0% | 90.0% | 93.3% | 70.0% | −750 |
| 7 | 95.0% | 96.7% | 93.3% | 76.7% | −450 |
| **10** | **98.3%** | **96.7%** | **93.3%** | **90.0%** | **baseline** |
| 15 | 98.3% | 96.7% | 100.0% | 100.0% | +750 |
| 20 | 100.0% | 100.0% | 100.0% | 100.0% | +1500 |

K=10 hits 90–98% recall across all codebases. Django and Kubernetes both reach 100% at K=15 — their misses rank 11th–15th, pushed down by structurally similar siblings (test `models.py` files in Django, dozens of `admission.go` plugins in Kubernetes). Excalidraw's one miss (`polygon.ts`) doesn't land until top-20, crowded out by element files sharing geometric vocabulary. Each result adds ~150 tokens (~$0.0005 at Sonnet pricing), so the cost of 10 results vs 5 is negligible for agents that routinely consume thousands of tokens per tool call.

### Model comparison

Six 384-dimension ONNX embedding models were evaluated on mimirs and Excalidraw with hybrid search (70/30 vector/BM25). The two viable options:

| Model | Download | Recall (Excalidraw) | MRR (Excalidraw) | Index speed |
|---|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | 23MB | 90.0% | 0.491 | 1.0× |
| gte-small | 67MB | 95.0% | 0.507 | 1.6× |

The other four candidates (snowflake-arctic-embed-xs, mxbai-embed-xsmall-v1, snowflake-arctic-embed-s, all-MiniLM-L12-v2) all degraded at scale — recall dropped to 60–85% on larger codebases — and are not recommended.

**gte-small** is the clear runner-up: +5pp recall and higher MRR across all codebases, at the cost of 1.6× slower indexing and a 67MB download (vs 23MB).

## Decision

**Default: all-MiniLM-L6-v2 at top-10.** Fastest indexing, smallest download, and strong recall at all scales. JSON and CSS/SCSS/LESS files removed from default indexing — locale bundles, config, and stylesheets add noise without helping code search.

Users who want maximum recall can opt into gte-small:

```json
{
  "embeddingModel": "Xenova/gte-small",
  "embeddingDim": 384
}
```

This trades ~60% slower indexing for +5pp recall on large codebases (676 files: 95% vs 90%) and consistently higher MRR.

## Embedding merge

all-MiniLM-L6-v2 has a hard 256-token max sequence length. Anything beyond that is silently truncated — the embedding vector only represents the beginning of the chunk. AST-aware chunking preserves whole functions (no size limit), so large functions lose significant content from their embedding.

### Truncation analysis (mimirs, 883 AST chunks)

| Metric | Value |
|---|---|
| Chunks exceeding 256 tokens | 207 / 883 (23.4%) |
| Average content lost to truncation | 45.8% |
| Worst case (largest function) | 75%+ content invisible to vector search |

### Merge strategy

For chunks exceeding 256 tokens: split into overlapping 256-token windows (32-token overlap), embed each window, average the vectors, L2-normalize. The chunk text stays intact for FTS and display — only the embedding changes.

### Tail-content retrieval test

To measure impact, we extracted phrases from past the 256-token cutoff (invisible to the truncated embedding) and measured cosine similarity of the query against both strategies:

| Entity | Sim (truncated) | Sim (merged) | Delta |
|---|---|---|---|
| processFile | 0.358 | 0.468 | +0.110 |
| processFileIncremental | 0.313 | 0.472 | +0.159 |
| indexDirectory | 0.421 | 0.486 | +0.065 |
| hybridSearch | 0.387 | 0.453 | +0.066 |
| chunkText | 0.519 | 0.618 | +0.099 |
| Avg across 15 largest | — | — | **+0.101** |

Merged embeddings consistently improve retrieval for content past the truncation point. The improvement is largest for functions where the distinctive logic (error handling, return paths, edge cases) appears in the second half.

### Cost

- **Index time**: ~5-15% slower (extra tokenization + window embedding for 23% of chunks)
- **Query time**: zero overhead — merge happens entirely at index time
- **Storage**: identical — one 384d vector per chunk regardless of strategy

Enabled by default (`embeddingMerge: true`). Disable with `"embeddingMerge": false` in `.mimirs/config.json`.

### Reproducing

```bash
bun benchmarks/ast-truncation-analysis.ts
```

## Pipeline improvements

The search pipeline applies six post-retrieval optimizations (no re-indexing needed):

1. **Source file boost** — source paths 1.1x, test paths 0.85x
2. **Symbol expansion** — exact symbol name matches injected into candidates at 0.75 base score
3. **Dependency graph boost** — files with more importers get a logarithmic score boost
4. **Doc expansion** — doc files in top-K expand the result set instead of displacing code
5. **Filename affinity boost** — if query words match the filename stem, boost 1.0 + 0.1 × match count
6. **Boilerplate demotion** — type definitions (`types.go`), generated files (`zz_generated*`), and boilerplate paths (`applyconfigurations/`, `testing/`) are demoted 0.75–0.85×

Cross-encoder reranking was removed in v0.3.27 — it loaded a ~80MB model, added latency to every query, and benchmarked at +0pp recall at top-10. Worse, the ms-marco cross-encoder (trained on web Q&A) actively hurt code search by preferring test files over source definitions.

## Reproducing

```bash
bunx mimirs index .
bunx mimirs benchmark benchmarks/mimirs-queries.json --dir . --top 10

# Excalidraw (clone first: git clone --depth 1 https://github.com/excalidraw/excalidraw.git /tmp/excalidraw-bench)
bunx mimirs index /tmp/excalidraw-bench
bunx mimirs benchmark benchmarks/excalidraw-queries.json --dir /tmp/excalidraw-bench --top 10

# Django (clone first: git clone --depth 1 https://github.com/django/django.git /tmp/django-bench)
bunx mimirs index /tmp/django-bench
bunx mimirs benchmark benchmarks/django-queries.json --dir /tmp/django-bench --top 10

# Compare models
bunx mimirs benchmark-models benchmarks/mimirs-queries.json \
  --models "Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5" --dir . --top 10
```

Query files: [mimirs](benchmarks/mimirs-queries.json) (30 queries), [Excalidraw](benchmarks/excalidraw-queries.json) (30 queries), [Django](benchmarks/django-queries.json) (30 queries), [Kubernetes](benchmarks/kubernetes-queries.json) (30 queries).

### Kubernetes

```bash
# Clone (shallow — full history not needed for indexing)
git clone --depth 1 https://github.com/kubernetes/kubernetes.git /tmp/k8s-bench

# Configure: Go files only, exclude test files
mkdir -p /tmp/k8s-bench/.mimirs
cat > /tmp/k8s-bench/.mimirs/config.json << 'EOF'
{
  "include": ["**/*.go"],
  "exclude": ["vendor/**", ".git/**", "**/*_test.go", "test/**", "third_party/**", "hack/**", ".mimirs/**"]
}
EOF

# Index (~39 min on M-series Mac)
bunx mimirs index /tmp/k8s-bench

# Benchmark
bunx mimirs benchmark benchmarks/kubernetes-queries.json --dir /tmp/k8s-bench --top 10
```
