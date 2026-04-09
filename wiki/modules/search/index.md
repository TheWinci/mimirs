# Search Module

The Search module (`src/search/`) implements hybrid semantic + keyword search
over the indexed codebase. It combines vector similarity (embeddings) with
BM25 full-text ranking, applies path-based heuristics, and includes tooling
for evaluation and benchmarking.

## Architecture

```mermaid
flowchart TD
  subgraph SearchModule["Search Module (src/search/)"]
    hybrid_file["hybrid.ts -- core search engine"]
    usages_file["usages.ts -- regex and FTS helpers"]
    eval_file["eval.ts -- A/B evaluation"]
    bench_file["benchmark.ts -- recall benchmarks"]
  end

  hybrid_file --> dbMod["DB Module"]
  hybrid_file --> embedMod["Embeddings Module"]
  hybrid_file --> configMod["Config Module"]
  hybrid_file --> utilsMod["Utils Module"]

  eval_file --> hybrid_file
  bench_file --> hybrid_file
  eval_file --> configMod
  bench_file --> configMod

  toolsMod["Tools Module"] --> hybrid_file
  toolsMod --> usages_file
  cliMod["CLI Module"] --> hybrid_file
  cliMod --> eval_file
  cliMod --> bench_file
```

## Files

| File | Purpose |
|---|---|
| `hybrid.ts` | Core hybrid search engine -- merges vector and BM25 results with score adjustments |
| `usages.ts` | Helper utilities: `escapeRegex`, `sanitizeFTS` for safe FTS5 queries |
| `eval.ts` | A/B evaluation framework comparing search with and without RAG |
| `benchmark.ts` | Search quality benchmarks measuring recall and MRR |

## Core Search -- `hybrid.ts`

### `search()`

File-level search. Returns deduplicated results grouped by file path, keeping
the best score per file.

```ts
search(
  query: string,
  db: RagDB,
  topK?: number,        // default: 5
  threshold?: number,   // default: 0
  hybridWeight?: number,// default: 0.7
  generatedPatterns?: string[]
): Promise<DedupedResult[]>
```

**Pipeline:**

1. Embed the query string.
2. Run vector similarity search (`db.search`) for `topK * 4` candidates.
3. Run BM25 text search (`db.textSearch`) for `topK * 4` candidates.
   Falls back to vector-only if FTS fails.
4. Merge results via `mergeHybridScores`.
5. Deduplicate by file path, accumulating snippets.
6. Expand with symbol search -- extracts identifiers from the query and
   boosts files that match by exact symbol name (1.3x boost for existing
   results, 0.75 base score for symbol-only matches).
7. Apply path-based score adjustments (see below).
8. Expand doc window to prevent markdown files from displacing code results.
9. Sort by score and return the top K.

### `searchChunks()`

Chunk-level search. Returns individual semantic chunks ranked by relevance --
no file deduplication, so two chunks from the same file can both appear.

```ts
searchChunks(
  query: string,
  db: RagDB,
  topK?: number,        // default: 8
  threshold?: number,   // default: 0.3
  hybridWeight?: number,// default: 0.7
  generatedPatterns?: string[]
): Promise<ChunkResult[]>
```

Uses the same hybrid merge pipeline but operates on chunk-level DB methods
(`db.searchChunks`, `db.textSearchChunks`) and applies score adjustments
per-chunk rather than per-file. Adds parent grouping to replace sibling
sub-chunks with their parent when >= `parentGroupingMinCount` (default 2)
siblings appear.

### `mergeHybridScores()`

```ts
mergeHybridScores<T>(
  vectorResults: T[],
  textResults: T[],
  hybridWeight: number  // default: 0.7
): T[]
```

Combines vector and BM25 result lists using weighted scoring. The default
weight of **0.7** means 70% vector similarity, 30% BM25 keyword match.
Results that appear in both lists get a combined score; results in only one
list get their single-source score scaled by the appropriate weight.

### Score Adjustments

After merging, both `search` and `searchChunks` apply multiplicative
adjustments based on file metadata:

| Adjustment | Effect | Rationale |
|---|---|---|
| Source boost | +10% | Files in `src/`, `lib/`, `app/`, `pkg/` directories |
| Test demotion | -15% | Files matching test patterns (`*.test.*`, `*_test.*`, etc.) |
| Filename affinity | +10% per word | Query words found in the filename stem |
| Path segment match | +5% per word | Query words found in parent directory names |
| Boilerplate demotion | -20% | Known low-signal files (`types.go`, `doc.go`, `index.d.ts`, etc.) |
| Generated demotion | -50% | Files matching `config.generated` glob patterns |
| Dep graph boost | +5% * log2(importers + 1) | Files imported by many others are more central |

### Key Interfaces

```ts
interface DedupedResult {
  path: string;
  score: number;
  snippets: string[];
}

interface ChunkResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}
```

## FTS Helpers -- `usages.ts`

Two utility functions for safe text operations. **Not imported by
`hybrid.ts`** -- used by the Tools module for usage-search features.

- **`escapeRegex(s)`** -- escapes all regex metacharacters in a string.
- **`sanitizeFTS(query)`** -- prevents FTS5 operator injection by wrapping
  each token in double quotes. FTS5 treats bare `+`, `-`, `*`, `AND`, `OR`,
  `NOT`, `NEAR`, and parentheses as operators; quoting forces literal matching.

## A/B Evaluation -- `eval.ts`

Compares search quality with and without RAG by running identical tasks
under both conditions.

### Functions

| Function | Purpose |
|---|---|
| `loadEvalTasks(path)` | Parse a JSON file of `{ task, grading, expectedFiles? }` entries |
| `runEvalTask(task, db, projectDir, condition, topK?)` | Run a single task under "with-rag" or "without-rag" condition |
| `runEval(tasks, db, projectDir, topK?)` | Run all tasks under both conditions, return summary |
| `formatEvalReport(summary)` | Format results as a human-readable table |
| `saveEvalTraces(traces, outputPath)` | Persist traces as JSON for later analysis |

## Benchmarks -- `benchmark.ts`

Measures retrieval quality using recall@K and mean reciprocal rank (MRR).

### Functions

| Function | Purpose |
|---|---|
| `loadBenchmarkQueries(path)` | Parse a JSON file of `{ query, expected }` entries |
| `runBenchmark(queries, db, projectDir, topK?, hybridWeight?)` | Execute all queries and compute metrics |
| `formatBenchmarkReport(summary, topK?)` | Format results with missed/partial breakdown |

The CLI `benchmark` command exits non-zero if recall or MRR fall below
configured thresholds (`benchmarkMinRecall`, `benchmarkMinMrr`).

## Dependencies

| Direction | Module |
|---|---|
| Imports from | [DB](../db/), [Config](../config/), [Embeddings](../embeddings/), [Utils](../utils/) |
| Imported by | [Tools](../tools/), [CLI](../cli/) |

## See Also

- [Hybrid Search entity](../../entities/hybrid-search.md) -- detailed search
  internals and pipeline diagram
- [DB Module -- Search Operations](../db/internals.md#searchts--search-queries)
  -- the underlying SQLite vector and FTS5 queries
- [Embeddings Module](../embeddings/) -- how query strings are
  converted to vectors
- [Indexing Module](../indexing/) -- how content enters the search index
- [Data Flow](../../data-flow.md) -- search pipeline diagram
- [Architecture](../../architecture.md) -- system-wide overview
