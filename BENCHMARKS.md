# Benchmarks

Search quality benchmarks for local-rag, measured on two codebases.
Last updated 2026-03-23, version 0.2.15.

## Method

Each benchmark is a set of queries with known expected files. Metrics:

- **Recall@K** — fraction of expected files found in the top-K results, averaged across queries
- **MRR** (Mean Reciprocal Rank) — 1/(rank of first expected file), averaged across queries. Higher = expected file ranks closer to #1
- **Zero-miss rate** — percentage of queries where none of the expected files appeared in results

All benchmarks use hybrid search (70% vector / 30% BM25). Reranking uses the ms-marco-MiniLM-L-6-v2 cross-encoder.

## Results

### local-rag (self-benchmark)

95 files indexed (source, tests, docs, configs). 20 queries targeting specific source files by function/class names and implementation concepts.

| Config | Recall@5 | MRR | Zero-miss |
|---|---|---|---|
| Hybrid + reranking | **77.5%** | **0.492** | **20.0%** |
| Hybrid only | 70.0% | 0.327 | 30.0% |
| Hybrid + reranking (top-10) | **95.0%** | **0.539** | **5.0%** |

Reranking effect: **+7.5pp recall**, **+0.165 MRR**, **-10pp zero-miss rate**.

### Express.js (external project)

161 files indexed (source, tests, examples, docs, markdown). 15 queries targeting core `lib/` files by API methods and implementation details.

| Config | Recall@5 | MRR | Zero-miss |
|---|---|---|---|
| Hybrid + reranking | 73.3% | **0.580** | 26.7% |
| Hybrid only | **80.0%** | 0.466 | **20.0%** |
| Hybrid + reranking (top-10) | **93.3%** | **0.589** | **6.7%** |

On Express, reranking improves ranking precision (MRR +0.114) but slightly reduces recall at top-5 (-6.7pp). This is expected: the cross-encoder promotes the most precisely relevant result to rank 1, but may push borderline-relevant files out of the top-5 cutoff.

## Analysis

**What works well:**
- At top-10, both codebases achieve 93-95% recall — the expected file is almost always in the result set
- MRR with reranking is 0.49-0.58, meaning the expected file typically appears in the top 2-3 results
- Hybrid search (vector + BM25) consistently outperforms either alone

**Where search struggles:**
- Small, highly-referenced files (e.g. `db/index.ts`, `config/index.ts`) — these are mentioned in many files, so test files and docs that reference them can outrank the source
- Files whose content is mostly re-exports or delegation (e.g. `db/index.ts` is a facade that delegates to store modules)
- Queries that match documentation descriptions better than actual code (descriptive queries favor README/markdown over implementation)

**Reranking tradeoffs:**
- Consistently improves MRR (ranking quality) across both codebases
- On small, focused codebases (local-rag): improves both recall and MRR
- On larger codebases with many test files (Express): improves MRR but can slightly reduce top-5 recall
- Recommendation: keep reranking on (default). The MRR improvement means agents find the right file faster

## Reproducing

```bash
# Index and benchmark local-rag
bunx @winci/local-rag index .
bunx @winci/local-rag benchmark benchmarks/local-rag-queries.json --dir . --top 5

# Without reranking
bunx @winci/local-rag benchmark benchmarks/local-rag-queries.json --dir . --top 5 --no-rerank

# Index and benchmark Express.js
git clone --depth 1 https://github.com/expressjs/express.git /tmp/express-bench
bunx @winci/local-rag index /tmp/express-bench
bunx @winci/local-rag benchmark benchmarks/express-queries.json --dir /tmp/express-bench --top 5
```

## Query files

- [benchmarks/local-rag-queries.json](benchmarks/local-rag-queries.json) — 20 queries for local-rag
- [benchmarks/express-queries.json](benchmarks/express-queries.json) — 15 queries for Express.js
