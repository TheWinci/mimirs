# Benchmarks

Search quality benchmarks measured on three codebases. Last updated 2026-03-23.

**Metrics:** Recall@K (fraction of expected files in top-K), MRR (1/rank of first hit), Zero-miss (queries with no expected file in results).

## Results

All results use hybrid search (70% vector / 30% BM25) with pipeline improvements enabled. Default top-K is 7.

### local-rag (97 files, 20 queries)

| Config | Recall@7 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **97.5%** | **0.588** | **0.0%** |
| bge-small-en-v1.5 (opt-in) | 97.5% | 0.540 | 0.0% |

### Express.js (161 files, 15 queries)

| Config | Recall@7 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **93.3%** | **0.678** | **6.7%** |
| bge-small-en-v1.5 (opt-in) | 80.0% | 0.541 | 20.0% |

### Excalidraw (761 files, 20 queries)

| Config | Recall@7 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **85.0%** | **0.512** | **15.0%** |

Excalidraw is the stress test — a large monorepo with 676 indexed files across `packages/`, `excalidraw-app/`, `dev-docs/`, and `examples/`. Remaining misses are files whose exports are imported in many other files (consumers outrank the source definition).

### Scaling behavior

| Codebase | Files | Recall@7 | MRR | Zero-miss |
|---|---|---|---|---|
| local-rag | 97 | 97.5% | 0.588 | 0.0% |
| Express.js | 161 | 93.3% | 0.678 | 6.7% |
| Excalidraw | 676 | 85.0% | 0.512 | 15.0% |

Recall degrades gracefully with codebase size. The dependency graph boost and symbol expansion help most on smaller codebases where the graph is complete.

### Why top-7?

Benchmark data showed misses landing at ranks 6-7 — just outside the previous top-5 window.

| K | local-rag Recall | Express Recall | Excalidraw Recall |
|---|---|---|---|
| 5 | 92.5% | 86.7% | — |
| **7** | **97.5%** | **93.3%** | **85.0%** |
| 10 | 97.5% | 93.3% | 90.0% |

Top-7 captures the gains on small/medium codebases with minimal extra context. On large codebases, top-10 adds +5pp.

### Model tradeoff

| | all-MiniLM-L6-v2 | bge-small-en-v1.5 |
|---|---|---|
| Download size | 23MB | 127MB |
| Index time (97 files) | ~40s | ~80s |
| Best for | General use, JS codebases | TypeScript with deep import graphs |

## Decision

**Default: all-MiniLM-L6-v2 at top-7.** Faster indexing, smaller download, higher MRR, and better recall on Express. JSON and CSS/SCSS/LESS files removed from default indexing — locale bundles, config, and stylesheets add noise without helping code search.

Users who want maximum recall on TypeScript projects can opt in:

```json
{
  "embeddingModel": "Xenova/bge-small-en-v1.5",
  "embeddingDim": 384
}
```

## Pipeline improvements

The search pipeline applies five post-retrieval optimizations (no re-indexing needed):

1. **Source file boost** — source paths 1.1x, test paths 0.85x
2. **Symbol expansion** — exact symbol name matches injected into candidates at 0.75 base score
3. **Dependency graph boost** — files with more importers get a logarithmic score boost
4. **Doc expansion** — doc files in top-K expand the result set instead of displacing code
5. **Conditional reranking** — skip the cross-encoder for code-heavy queries (≥50% identifiers)

Impact of pipeline on all-MiniLM-L6-v2 (at top-5, before top-K change):

| Codebase | Without pipeline | With pipeline | Delta |
|---|---|---|---|
| local-rag | 77.5% | 92.5% | +15.0pp |
| Express.js | 73.3% | 86.7% | +13.4pp |

## Reproducing

```bash
bunx @winci/local-rag index .
bunx @winci/local-rag benchmark benchmarks/local-rag-queries.json --dir . --top 7

# Excalidraw (clone first: git clone --depth 1 https://github.com/excalidraw/excalidraw.git /tmp/excalidraw-bench)
bunx @winci/local-rag index /tmp/excalidraw-bench
bunx @winci/local-rag benchmark benchmarks/excalidraw-queries.json --dir /tmp/excalidraw-bench --top 7

# Compare models
bunx @winci/local-rag benchmark-models benchmarks/local-rag-queries.json \
  --models "Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5" --dir . --top 7
```

Query files: [local-rag](benchmarks/local-rag-queries.json) (20 queries), [Express.js](benchmarks/express-queries.json) (15 queries), [Excalidraw](benchmarks/excalidraw-queries.json) (20 queries).
