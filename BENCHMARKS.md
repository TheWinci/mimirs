# Benchmarks

Search quality benchmarks measured on four codebases. Last updated 2026-03-30.

**Metrics:** Recall@K (fraction of expected files in top-K), MRR (1/rank of first hit), Zero-miss (queries with no expected file in results).

## Results

All results use hybrid search (70% vector / 30% BM25) with pipeline improvements (source/test path boost, symbol expansion, dependency graph boost, doc expansion, filename affinity boost, boilerplate demotion). Default top-K is 10.

### mimirs (97 files, 20 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.715** | **0.0%** |

### Express.js (161 files, 15 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.922** | **0.0%** |

### Excalidraw (676 files, 20 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.366** | **0.0%** |

Excalidraw is a stress test — a large monorepo with 676 indexed files across `packages/`, `excalidraw-app/`, `dev-docs/`, and `examples/`. MRR is lower than the smaller codebases because heavily-imported utility files have many consumers that score competitively, pushing the source definition lower in rank — but it always lands in the top 10.

### Kubernetes (8,691 files, 20 queries)

The scale test — the full Kubernetes codebase (Go), excluding test files and vendor/. 8,691 source files (including generated), 351 MB index.

| Config | Recall@10 | Recall@15 | MRR | Zero-miss@10 |
|---|---|---|---|---|
| **Excl. tests + generated demotion + top-15** | **100.0%** | **100.0%** | **0.496** | **0.0%** |
| Excl. tests + generated demotion (default top-10) | 80.0% | 100.0% | 0.471 | 20.0% |
| Excl. tests only (before pipeline v2) | 65.0% | — | 0.320 | 35.0% |
| Including test files (11,193 files) | 65.0% | — | 0.272 | 35.0% |

At 8.7k files, Kubernetes is 12× larger than Excalidraw and represents an extreme test of semantic search. With proper configuration — excluding test files, demoting generated files via the `generated` config, and `"searchTopK": 15` — recall reaches **100%**. The 4 files that miss at top-10 all rank 11th–15th, pushed down by structurally similar siblings (e.g. `chain.go` among dozens of `admission.go` plugins, `csi_plugin.go` among other volume plugins).

**Recommended Kubernetes config:**

```json
{
  "include": ["**/*.go"],
  "exclude": ["vendor/**", "**/*_test.go", "test/**", "third_party/**", "hack/**"],
  "generated": ["applyconfigurations/**", "**/zz_generated*", "**/fake_*", "**/*_generated.go"],
  "searchTopK": 15
}
```

**Impact of excluding test files:** Removing 2,640 test files eliminated 57,753 chunks (28%), shrunk the DB by 34% (521→344 MB), cut index time by 37% (62→39 min), and improved MRR by 18% (0.272→0.320). Recall@20 gained 5pp (85→90%). Test files contain the same domain vocabulary as source files, creating ranking noise without adding navigational value.

**Indexing performance:**

| Metric | With tests | Without tests |
|---|---|---|
| Files indexed | 11,193 | 8,553 |
| Chunks | 207,598 | 149,845 |
| DB size | 521 MB | 344 MB |
| Index time | 62 min | 39 min |
| Search latency (per query) | ~337 ms | ~230 ms |

### Scaling behavior

| Codebase | Files | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|
| mimirs | 97 | 100.0% | 0.651 | 0.0% |
| Express.js | 161 | 100.0% | 0.922 | 0.0% |
| Excalidraw | 676 | 100.0% | 0.366 | 0.0% |
| Kubernetes | 8,691 | 80.0% (100% @15) | 0.496 | 20.0% (0% @15) |

100% recall on codebases up to ~700 files at default top-10. At Kubernetes scale (8.7k files), recall reaches 80% at top-10 and **100% at top-15** with proper configuration (test exclusion, generated file demotion, `searchTopK: 15`). The 5 extra results add ~750 tokens per query — negligible for agents that routinely consume thousands of tokens per tool call.

### Why top-10?

We benchmarked at K=5, 7, 10, 15, 20 across all three codebases to find the diminishing-returns point.

| K | mimirs | Express | Excalidraw | Extra tokens vs K=10 |
|---|---|---|---|---|
| 5 | 92.5% | 86.7% | 80.0% | −750 |
| 7 | 97.5% | 93.3% | 85.0% | −450 |
| **10** | **97.5%** | **93.3%** | **90.0%** | **baseline** |
| 15 | 100.0% | 93.3% | 90.0% | +750 |
| 20 | 100.0% | 100.0% | 90.0% | +1500 |

K=10 is the plateau for large codebases — Excalidraw gains nothing past 10. Each result adds ~150 tokens (~$0.0005 at Sonnet pricing), so the cost of 10 results vs 5 is negligible for agents that routinely consume thousands of tokens per tool call.

### Model comparison (5 candidates, 384d)

Comprehensive comparison of all 384-dimension ONNX embedding models viable for local code search. All models tested on identical queries with hybrid search (70/30 vector/BM25) and pipeline improvements. Note: these numbers were collected before the reranker removal — the default model's current scores are in the tables above.

#### Recall@10

| Model | mimirs (97) | Express (161) | Excalidraw (676) |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **93.3%** | **90.0%** |
| snowflake-arctic-embed-xs | 100.0% | 73.3% | 75.0% |
| mxbai-embed-xsmall-v1 | 100.0% | 93.3% | 90.0% |
| **gte-small** | **100.0%** | **100.0%** | **95.0%** |
| snowflake-arctic-embed-s | 87.5% | 60.0% | 85.0% |
| all-MiniLM-L12-v2 | 100.0% | 93.3% | 80.0% |

#### MRR

| Model | mimirs | Express | Excalidraw |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **0.572** | **0.672** | **0.491** |
| snowflake-arctic-embed-xs | 0.581 | 0.561 | 0.387 |
| mxbai-embed-xsmall-v1 | 0.603 | 0.669 | 0.464 |
| **gte-small** | **0.656** | **0.731** | **0.507** |
| snowflake-arctic-embed-s | 0.654 | 0.327 | 0.394 |
| all-MiniLM-L12-v2 | 0.645 | 0.636 | 0.404 |

#### Index time

| Model | 97 files | 161 files | 676 files | Relative |
|---|---|---|---|---|
| all-MiniLM-L6-v2 | 59s | 57s | 593s | 1.0× |
| snowflake-arctic-embed-xs | 69s | 59s | 458s | ~0.9× |
| mxbai-embed-xsmall-v1 | 69s | 69s | 448s | ~0.9× |
| gte-small | 132s | 118s | 866s | ~1.6× |
| snowflake-arctic-embed-s | 120s | 115s | 869s | ~1.6× |
| all-MiniLM-L12-v2 | ~86s | — | ~863s | ~1.5× |

#### Summary

| Model | Download | Strengths | Weaknesses |
|---|---|---|---|
| **all-MiniLM-L6-v2** | 23MB | Fast indexing, good recall at all scales | Lower MRR than gte-small |
| snowflake-arctic-embed-xs | 45MB | Fast indexing | Poor recall at scale (75% on Excalidraw) |
| mxbai-embed-xsmall-v1 | 60MB | Matches L6 recall, fast | Slightly lower MRR |
| gte-small | 67MB | Best recall and MRR across all codebases | 1.6× slower indexing |
| snowflake-arctic-embed-s | 110MB | — | Worst recall (60% on Express), slow |
| all-MiniLM-L12-v2 | 33MB | Good MRR on small codebases | −10pp recall on Excalidraw, 1.5× slower |

**gte-small** is the clear runner-up: +5pp recall and +0.016 MRR on Excalidraw, +6.7pp recall and +0.059 MRR on Express, with identical 100% recall on small codebases. The cost is 1.6× slower indexing and a 67MB download (vs 23MB). The two Snowflake models and MiniLM-L12 all degrade at scale and are not recommended.

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

Cross-encoder reranking was removed in v0.3.27 — it loaded a ~80MB model, added latency to every query, and benchmarked at +0pp recall at top-10 across all three codebases. Worse, the ms-marco cross-encoder (trained on web Q&A) actively hurt code search by preferring test files over source definitions. Removing it improved recall from 90-97.5% to 100% across the board.

## Reproducing

```bash
bunx mimirs index .
bunx mimirs benchmark benchmarks/mimirs-queries.json --dir . --top 10

# Excalidraw (clone first: git clone --depth 1 https://github.com/excalidraw/excalidraw.git /tmp/excalidraw-bench)
bunx mimirs index /tmp/excalidraw-bench
bunx mimirs benchmark benchmarks/excalidraw-queries.json --dir /tmp/excalidraw-bench --top 10

# Compare models
bunx mimirs benchmark-models benchmarks/mimirs-queries.json \
  --models "Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5" --dir . --top 10
```

Query files: [mimirs](benchmarks/mimirs-queries.json) (20 queries), [Express.js](benchmarks/express-queries.json) (15 queries), [Excalidraw](benchmarks/excalidraw-queries.json) (20 queries), [Kubernetes](benchmarks/kubernetes-queries.json) (20 queries).

### Kubernetes

```bash
# Clone (shallow — full history not needed for indexing)
git clone --depth 1 https://github.com/kubernetes/kubernetes.git /tmp/k8s-bench

# Configure: Go files only, exclude test files
mkdir -p /tmp/k8s-bench/.rag
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
