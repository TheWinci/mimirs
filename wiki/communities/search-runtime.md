# Search Runtime

> [Architecture](../architecture.md)
>
> Generated from `79e963f` · 2026-04-26

The Search Runtime community is the hybrid retrieval engine at the heart of mimirs. It merges vector (semantic) and BM25 (keyword) results, applies a layered stack of ranking boosts, and provides the benchmark and eval harnesses used to measure and improve retrieval quality. Every MCP search tool call and CLI search command flows through this community before hitting the database.

## Per-file breakdown

### `src/search/hybrid.ts` — The retrieval engine

`src/search/hybrid.ts` is the highest-PageRank file in the community and the sole implementation of the two public search functions: `search` (file-level, deduplicated) and `searchChunks` (chunk-level, no file deduplication). Both functions follow the same pipeline: embed the query, run vector and FTS queries in parallel against the DB, merge scores with `mergeHybridScores`, apply a four-stage boost pipeline, and return results.

`DEFAULT_HYBRID_WEIGHT = 0.7` controls the blend: 70% vector score, 30% BM25 score. This is the constant callers override by passing `hybridWeight` explicitly; the `src/config/index.ts` `hybridWeight` field is passed through from `resolveProject` in tool handlers.

The boost pipeline runs in this order: `applyPathBoost` (source up / test down), `applyFilenameBoost` (filename-query affinity, boilerplate demotion, generated file demotion), `applyGraphBoost` (import-count logarithmic boost). Boosts are multiplicative for path/filename and additive for graph. The constants are:

- Test file multiplier: `0.85`
- Source file multiplier: `1.1`
- Boilerplate filename demotion: `0.8`
- Generated file demotion: `GENERATED_DEMOTION = 0.75`
- Stem word match boost: `+0.1` per matching word (capped at the count)
- Path segment match boost: `+0.05` per matching segment
- Symbol-only match base score: `0.75`
- Symbol expansion boost for existing results: `Math.max(existing.score, existing.score * 1.3)`
- Graph import-count boost: `0.05 * Math.log2(importerCount + 1)` (additive)

`BOILERPLATE_BASENAMES` is a hardcoded set of filenames demoted regardless of query affinity. It covers conventional Go type/doc/constants files and their TypeScript equivalents (type declaration files, index declaration files). These files contain vocabulary without implementations, so they appear in FTS results for nearly every query — demotion keeps them from displacing real hits.

`STOP_WORDS` is a set of 50 common English and code-vocabulary words filtered out before filename affinity and symbol expansion. Words shorter than 3 characters are also excluded.

Doc expansion (`expandForDocs`) prevents markdown files from displacing code results: when the initial top-K contains both docs and code, the result set is expanded by the doc count so code files keep their slots.

`searchChunks` additionally applies count-based parent grouping via `groupByParent`: when two or more sub-chunks from the same parent chunk (same `parent_id`) appear in results, they are replaced by the parent chunk at the best child score. The minimum count is hardcoded to 2 and is not user-configurable in this file (it is `parentGroupingMinCount` from config, but `searchChunks` calls `groupByParent` with its default of 2 directly).

`mergeHybridScores` is a generic function (works on any `{ score, path, chunkIndex }` type) that combines two ranked lists into one scored map, computing the blended score as `hybridWeight * vectorScore + (1 - hybridWeight) * textScore`. Results that appear in only one list get a score of 0 on the missing dimension.

### `src/search/usages.ts` — FTS sanitization utilities

`src/search/usages.ts` is a tiny two-function module consumed by both `src/db/search.ts` and `src/db/conversation.ts` and `src/db/git-history.ts`. `sanitizeFTS` wraps each whitespace-split token in double quotes before passing it to FTS5 MATCH, which forces literal matching instead of operator interpretation — without this, tokens like `NOT`, `AND`, bare parentheses, and the `+` prefix all trigger FTS5 query syntax. `escapeRegex` escapes regex metacharacters for the word-boundary regex used in `findUsages`.

### `src/search/benchmark.ts` — Retrieval quality benchmark

`src/search/benchmark.ts` provides a quantitative benchmark harness for the search function. A benchmark file is a JSON array of `{ query, expected }` objects where `expected` is a list of file paths (relative or absolute). `runBenchmark` runs each query through `search`, normalizes paths to absolute, and computes three metrics per query: recall at K (fraction of expected files found in top-K), reciprocal rank (1/rank of the first expected file, 0 if none), and hit (at least one expected file found). The summary aggregates these as `recallAtK` (mean recall), `mrr` (mean reciprocal rank), and `zeroMissRate` (fraction of queries where no expected file appeared). Config fields `benchmarkTopK` (default 5) and `benchmarkMinRecall` (default 0.8) and `benchmarkMinMrr` (default 0.6) set pass/fail thresholds used by the `benchmark` CLI command.

### `src/search/eval.ts` — Agent-level eval harness

`src/search/eval.ts` provides a higher-level eval for measuring the impact of RAG on agent task performance. An eval task is a `{ task, grading, expectedFiles? }` object. `runEvalTask` simulates two conditions: `"with-rag"` runs a semantic search on the task description and returns what was found; `"without-rag"` returns empty results. `runEval` runs all tasks under both conditions and computes averages for search result count, files referenced, duration, and file hit rate. `saveEvalTraces` persists full `EvalTrace` objects to a JSON file for offline inspection. The eval harness is primarily a developer tool for before/after comparison when changing search parameters.

## How it works

```sequenceDiagram
    participant MCP as "MCP tool handler"
    participant hybridSrc as "src/search/hybrid.ts"
    participant embedder as "src/embeddings/embed.ts"
    participant db as "RagDB"
    participant fts as "FTS5 index"
    participant vec as "vec_chunks"

    MCP->>hybridSrc: search(query, db, topK, ...)
    hybridSrc->>embedder: embed(query)
    embedder-->>hybridSrc: Float32Array
    hybridSrc->>vec: vectorSearch(embedding, topK*4)
    vec-->>hybridSrc: SearchResult[]
    hybridSrc->>fts: textSearch(sanitizeFTS(query), topK*4)
    fts-->>hybridSrc: SearchResult[]
    hybridSrc->>hybridSrc: mergeHybridScores(vector, text, weight)
    hybridSrc->>hybridSrc: dedup by file path
    hybridSrc->>db: searchSymbols(identifiers) [optional]
    hybridSrc->>hybridSrc: applyPathBoost / applyFilenameBoost / applyGraphBoost
    hybridSrc->>hybridSrc: expandForDocs
    hybridSrc->>db: logQuery(query, results, durationMs)
    hybridSrc-->>MCP: DedupedResult[]
```

Both `search` and `searchChunks` fetch `topK * 4` results from each source to give the merge and deduplication stages enough candidates. FTS queries are wrapped in a try/catch — if the FTS5 index is corrupt or the query triggers a parse error, the function falls back to vector-only results and logs a debug message. The query is always logged at the end, regardless of whether it returned results.

## Dependencies and consumers

```flowchart LR
    configSrc["src/config/index.ts"]
    dbSrc["src/db/index.ts"]
    embedSrc["src/embeddings/embed.ts"]
    logSrc["src/utils/log.ts"]

    subgraph searchComm ["src/search/"]
        hybridSrc["hybrid.ts"]
        usagesSrc["usages.ts"]
        benchSrc["benchmark.ts"]
        evalSrc["eval.ts"]
    end

    configSrc --> hybridSrc
    configSrc --> benchSrc
    configSrc --> evalSrc
    dbSrc --> hybridSrc
    dbSrc --> benchSrc
    dbSrc --> evalSrc
    embedSrc --> hybridSrc
    logSrc --> hybridSrc
    usagesSrc --> dbSrc

    hybridSrc --> benchSrc
    hybridSrc --> evalSrc
```

The search community is consumed by MCP tool handlers (`src/tools/search.ts`, `src/tools/wiki-tools.ts`), CLI commands (`search-cmd.ts`, `demo.ts`, `benchmark.ts`, `eval.ts`), and benchmarks. `src/search/usages.ts` flows in the opposite direction — it is consumed by the DB layer, not by the hybrid engine itself.

## Internals

**FTS fallback is silent.** When the FTS query throws (malformed query, corrupt index), `search` and `searchChunks` catch the error, log at `debug` level, and continue with vector-only results. Callers have no way to detect the fallback. This is intentional — a degraded but functional search is better than a thrown error in an MCP call.

**Symbol expansion runs on every query that contains an identifier.** `extractIdentifiers` scans the query for camelCase, PascalCase, snake_case, and dotted identifiers at least 3 characters long and not in `STOP_WORDS`. For each identifier, `db.searchSymbols(id, true, undefined, 5)` runs an exact case-insensitive match. A query like `"how does configureEmbedder work"` will also run a symbol lookup for `configureEmbedder`, boosting any file that exports that exact symbol.

**Boilerplate demotion applies before filename affinity.** If a file is in `BOILERPLATE_BASENAMES`, it receives the `0.8` multiplier and filename-affinity boosting is skipped for it entirely — the two are not combined.

**Generated file demotion requires explicit config.** The `GENERATED_DEMOTION = 0.75` multiplier only applies when `config.generated` lists glob patterns. The default `generated: []` means no files are demoted as generated unless the user configures them in `.mimirs/config.json`.

**Doc expansion can increase result count above topK.** When the initial top-K contains `D` doc files alongside at least one code file, the returned slice is `pool.slice(0, topK + D)`. Callers that assume exactly `topK` results will see more. The MCP tool handler in `src/tools/search.ts` passes this through without capping.

**`logQuery` is always called, even on empty results.** This means every search — including failed or empty ones — appears in `query_log`, which is by design: zero-result queries are precisely what `getAnalytics` surfaces as `zeroResultQueries`.

## Invariants

- `mergeHybridScores` requires that `vectorResults` and `textResults` use the same `path + chunkIndex` key space. Mixing file-level and chunk-level results in the same call produces undefined behavior.
- FTS queries must be sanitized with `sanitizeFTS` before passing to `db.textSearch`. Passing raw user strings may trigger FTS5 query syntax errors.
- `hybridWeight` must be in `[0, 1]`. Values outside this range produce scores that can exceed 1 or go negative, breaking the boost arithmetic.
- `topK` must be positive. Passing 0 or negative values causes the SQL LIMIT to misbehave in SQLite's vec0 virtual table.
- The `generatedPatterns` list must use glob patterns compatible with `buildGeneratedMatcher` — only `dir/**`, `**/*suffix`, and `**/prefix*` forms are recognized; other patterns fall back to a substring regex match on the full path.

## Failure modes

**FTS index corruption.** If `fts_chunks` is corrupted (can happen with interrupted writes or extension mismatches), `db.textSearch` will throw on every call. `search` and `searchChunks` catch this and fall back to vector-only silently. Recovery requires rebuilding the FTS index: `INSERT INTO fts_chunks(fts_chunks) VALUES ('rebuild')`.

**Dimension mismatch on embed output.** If `configureEmbedder` was called with a different model than was used to build the index, the query embedding will have a different dimension than the stored embeddings. `sqlite-vec` will throw a dimension mismatch error that propagates to the caller as an uncaught exception — it is not caught inside `search`.

**Symbol expansion on very long queries.** `extractIdentifiers` applies the `IDENTIFIER_RE` regex to the full query string. Extremely long queries (>2000 chars, which the MCP schema allows) with many identifiers trigger O(identifiers) symbol lookups, each with a DB round-trip. The MCP handler limits queries to 2000 chars; the CLI does not enforce a limit.

**Empty FTS match from over-aggressive sanitization.** `sanitizeFTS` filters out empty tokens and returns `'""'` for an all-whitespace query. This triggers an FTS5 query that matches nothing, which is correct behavior — the fallback to vector-only provides results.

## See also

- [Architecture](../architecture.md)
- [CLI Commands](cli-commands.md)
- [Config & Embeddings](config-embeddings.md)
- [Data flows](../data-flows.md)
- [Database Layer](db-layer.md)
- [Getting started](../getting-started.md)
