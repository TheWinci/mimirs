# Benchmarks

Search quality benchmarks measured on three codebases. Last updated 2026-03-28.

**Metrics:** Recall@K (fraction of expected files in top-K), MRR (1/rank of first hit), Zero-miss (queries with no expected file in results).

## Results

All results use hybrid search (70% vector / 30% BM25) with pipeline improvements (source/test path boost, symbol expansion, dependency graph boost, doc expansion). Default top-K is 10.

### local-rag (97 files, 20 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.677** | **0.0%** |

### Express.js (161 files, 15 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.922** | **0.0%** |

### Excalidraw (676 files, 20 queries)

| Config | Recall@10 | MRR | Zero-miss |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **0.366** | **0.0%** |

Excalidraw is the stress test — a large monorepo with 676 indexed files across `packages/`, `excalidraw-app/`, `dev-docs/`, and `examples/`. MRR is lower than the smaller codebases because highly-imported utility files have many consumers that score competitively, pushing the source definition lower in rank — but it always lands in the top 10.

### Scaling behavior

| Codebase | Files | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|
| local-rag | 97 | 100.0% | 0.677 | 0.0% |
| Express.js | 161 | 100.0% | 0.922 | 0.0% |
| Excalidraw | 676 | 100.0% | 0.366 | 0.0% |

100% recall across all three codebases. The dependency graph boost and symbol expansion ensure source definitions are found even in large monorepos where consumer files outnumber definitions.

### Why top-10?

We benchmarked at K=5, 7, 10, 15, 20 across all three codebases to find the diminishing-returns point.

| K | local-rag | Express | Excalidraw | Extra tokens vs K=10 |
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

| Model | local-rag (97) | Express (161) | Excalidraw (676) |
|---|---|---|---|
| **all-MiniLM-L6-v2 (default)** | **100.0%** | **93.3%** | **90.0%** |
| snowflake-arctic-embed-xs | 100.0% | 73.3% | 75.0% |
| mxbai-embed-xsmall-v1 | 100.0% | 93.3% | 90.0% |
| **gte-small** | **100.0%** | **100.0%** | **95.0%** |
| snowflake-arctic-embed-s | 87.5% | 60.0% | 85.0% |
| all-MiniLM-L12-v2 | 100.0% | 93.3% | 80.0% |

#### MRR

| Model | local-rag | Express | Excalidraw |
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

### Truncation analysis (local-rag, 883 AST chunks)

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

Enabled by default (`embeddingMerge: true`). Disable with `"embeddingMerge": false` in `.rag/config.json`.

### Reproducing

```bash
bun benchmarks/ast-truncation-analysis.ts
```

## Pipeline improvements

The search pipeline applies four post-retrieval optimizations (no re-indexing needed):

1. **Source file boost** — source paths 1.1x, test paths 0.85x
2. **Symbol expansion** — exact symbol name matches injected into candidates at 0.75 base score
3. **Dependency graph boost** — files with more importers get a logarithmic score boost
4. **Doc expansion** — doc files in top-K expand the result set instead of displacing code

Cross-encoder reranking was removed in v0.3.27 — it loaded a ~80MB model, added latency to every query, and benchmarked at +0pp recall at top-10 across all three codebases. Worse, the ms-marco cross-encoder (trained on web Q&A) actively hurt code search by preferring test files over source definitions. Removing it improved recall from 90-97.5% to 100% across the board.

## Reproducing

```bash
bunx @winci/local-rag index .
bunx @winci/local-rag benchmark benchmarks/local-rag-queries.json --dir . --top 10

# Excalidraw (clone first: git clone --depth 1 https://github.com/excalidraw/excalidraw.git /tmp/excalidraw-bench)
bunx @winci/local-rag index /tmp/excalidraw-bench
bunx @winci/local-rag benchmark benchmarks/excalidraw-queries.json --dir /tmp/excalidraw-bench --top 10

# Compare models
bunx @winci/local-rag benchmark-models benchmarks/local-rag-queries.json \
  --models "Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5" --dir . --top 10
```

Query files: [local-rag](benchmarks/local-rag-queries.json) (20 queries), [Express.js](benchmarks/express-queries.json) (15 queries), [Excalidraw](benchmarks/excalidraw-queries.json) (20 queries).
