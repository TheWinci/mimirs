import { embed } from "../embeddings/embed";
import { RagDB, type SearchResult, type ChunkSearchResult } from "../db";
import { rerank } from "./reranker";
import { log } from "../utils/log";
import { basename } from "path";

export interface DedupedResult {
  path: string;
  score: number;
  snippets: string[];
}

export interface ChunkResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
}

// Default: 70% vector, 30% BM25
const DEFAULT_HYBRID_WEIGHT = 0.7;

/**
 * Merge vector and text search results using hybrid scoring.
 * Each result must have `score`, `path`, and `chunkIndex` at minimum.
 * Extra fields from the vector results are preserved on the merged output.
 */
export function mergeHybridScores<T extends { score: number; path: string; chunkIndex: number }>(
  vectorResults: T[],
  textResults: T[],
  hybridWeight: number
): T[] {
  const scoreMap = new Map<string, { item: T; vectorScore: number; textScore: number }>();

  for (const r of vectorResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    scoreMap.set(key, { item: r, vectorScore: r.score, textScore: 0 });
  }

  for (const r of textResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.textScore = r.score;
    } else {
      scoreMap.set(key, { item: r, vectorScore: 0, textScore: r.score });
    }
  }

  return Array.from(scoreMap.values()).map((entry) => ({
    ...entry.item,
    score: hybridWeight * entry.vectorScore + (1 - hybridWeight) * entry.textScore,
  }));
}

// ── Source file boost ────────────────────────────────────────────
// Common test path patterns
const TEST_PATTERNS = [
  /(?:^|[/\\])tests?[/\\]/i,
  /(?:^|[/\\])__tests__[/\\]/i,
  /(?:^|[/\\])spec[/\\]/i,
  /\.(?:test|spec)\.[^/\\]+$/i,
  /(?:^|[/\\])test_/i,
];
const SOURCE_PATTERNS = [
  /(?:^|[/\\])(?:src|lib|app|pkg|packages|internal|cmd)[/\\]/i,
];

function applyPathBoost(results: DedupedResult[]): DedupedResult[] {
  return results.map((r) => {
    const isTest = TEST_PATTERNS.some((p) => p.test(r.path));
    const isSource = SOURCE_PATTERNS.some((p) => p.test(r.path));
    let multiplier = 1.0;
    if (isTest) multiplier = 0.85;
    else if (isSource) multiplier = 1.1;
    return { ...r, score: r.score * multiplier };
  });
}

// ── Query-time symbol expansion ──────────────────────────────────
// Match identifiers: camelCase, PascalCase, snake_case, UPPER_CASE
const IDENTIFIER_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?\b/g;
// Filter out common English words that look like identifiers
const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "what", "when",
  "where", "how", "all", "not", "but", "has", "have", "get", "set",
  "new", "use", "can", "will", "should", "into", "each", "only",
  "does", "file", "files", "code", "function", "method", "class",
  "type", "return", "error", "value", "data", "name", "path", "index",
  "query", "result", "results", "search", "find", "create", "update",
  "delete", "remove", "add", "list", "check", "test", "run", "build",
]);

function extractIdentifiers(query: string): string[] {
  const matches = query.match(IDENTIFIER_RE) || [];
  return matches.filter((m) => {
    if (m.length < 3) return false;
    if (STOP_WORDS.has(m.toLowerCase())) return false;
    // Keep if it looks like a code identifier (has mixed case, underscore, or dot)
    return /[A-Z]/.test(m) || m.includes("_") || m.includes(".");
  });
}

function mergeSymbolResults(
  byFile: Map<string, DedupedResult>,
  symbolPaths: { path: string; snippet: string | null }[]
): void {
  for (const sym of symbolPaths) {
    const existing = byFile.get(sym.path);
    if (existing) {
      // Boost existing result — it matched both semantically and by symbol name
      existing.score = Math.max(existing.score, existing.score * 1.3);
    } else {
      // Add new result from symbol search — exact name matches are high-signal
      byFile.set(sym.path, {
        path: sym.path,
        score: 0.75, // Symbol-only matches: high base score (exact name hit)
        snippets: sym.snippet ? [sym.snippet] : [],
      });
    }
  }
}

// ── Code-query detection ────────────────────────────────────────
// A query is "code-heavy" when most of its meaningful words are identifiers.
// The ms-marco cross-encoder was trained on web Q&A and hurts ranking for
// identifier-heavy queries — skip reranking in that case.
function isCodeHeavyQuery(query: string, identifiers: string[]): boolean {
  const words = query.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  return identifiers.length / words.length >= 0.5;
}

// ── Doc expansion ───────────────────────────────────────────────
// Doc files (.md, .mdx) in results are useful context — they shouldn't
// displace code results. When docs appear in top-K, expand the result
// set so code files keep their slots.
const DOC_EXTENSIONS = /\.(?:md|mdx)$/i;

function expandForDocs<T extends { path: string }>(
  pool: T[],
  topK: number
): T[] {
  const initial = pool.slice(0, topK);
  const docCount = initial.filter((r) => DOC_EXTENSIONS.test(r.path)).length;
  if (docCount === 0) return initial;
  return pool.slice(0, topK + docCount);
}

// ── Dependency graph boost ───────────────────────────────────────
function applyGraphBoost(results: DedupedResult[], db: RagDB): DedupedResult[] {
  return results.map((r) => {
    const file = db.getFileByPath(r.path);
    if (!file) return r;
    const importerCount = db.getImportersOf(file.id).length;
    if (importerCount === 0) return r;
    // Modest logarithmic boost: a file imported by 8 others gets +0.15
    const boost = 0.05 * Math.log2(importerCount + 1);
    return { ...r, score: r.score + boost };
  });
}

export async function search(
  query: string,
  db: RagDB,
  topK: number = 5,
  threshold: number = 0,
  hybridWeight: number = DEFAULT_HYBRID_WEIGHT,
  enableReranking: boolean = false
): Promise<DedupedResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  // Fetch more than topK to allow deduplication
  const vectorResults = db.search(queryEmbedding, topK * 3);

  // BM25 text search for keyword matching
  let textResults: typeof vectorResults = [];
  try {
    textResults = db.textSearch(query, topK * 3);
  } catch (err) {
    log.debug(`FTS query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "search");
  }

  const merged = mergeHybridScores(vectorResults, textResults, hybridWeight);

  // Deduplicate by file path, keeping the best score per file
  const byFile = new Map<string, DedupedResult>();

  for (const result of merged) {
    if (threshold > 0 && result.score < threshold) continue;

    const existing = byFile.get(result.path);
    if (existing) {
      if (result.score > existing.score) {
        existing.score = result.score;
      }
      if (!existing.snippets.includes(result.snippet)) {
        existing.snippets.push(result.snippet);
      }
    } else {
      byFile.set(result.path, {
        path: result.path,
        score: result.score,
        snippets: [result.snippet],
      });
    }
  }

  // Symbol expansion — find exact symbol matches and merge into candidates
  const identifiers = extractIdentifiers(query);
  if (identifiers.length > 0) {
    const symbolHits: { path: string; snippet: string | null }[] = [];
    for (const id of identifiers) {
      const symbols = db.searchSymbols(id, true, undefined, 5);
      for (const s of symbols) {
        symbolHits.push({ path: s.path, snippet: s.snippet });
      }
    }
    mergeSymbolResults(byFile, symbolHits);
  }

  // Source file boost (source up, test down) + dependency graph boost
  const allSorted = applyGraphBoost(applyPathBoost(Array.from(byFile.values())), db)
    .sort((a, b) => b.score - a.score);

  // Skip reranking for code-heavy queries (ms-marco cross-encoder hurts them)
  const codeHeavy = isCodeHeavyQuery(query, identifiers);
  const shouldRerank = enableReranking && !codeHeavy;

  let results: DedupedResult[];
  if (shouldRerank && allSorted.length > 0) {
    // Cross-encoder reranking: re-score top candidates for precision
    const toRerank = allSorted.slice(0, topK * 2);
    try {
      const passages = toRerank.map((r) => r.snippets[0] ?? "");
      const rerankScores = await rerank(query, passages);
      const reranked = toRerank
        .map((r, i) => ({ ...r, score: rerankScores[i] }))
        .sort((a, b) => b.score - a.score);
      // Doc expansion — docs are bonus results, don't displace code
      results = expandForDocs(reranked, topK);
    } catch (err) {
      log.warn(`Reranking failed, using hybrid scores: ${err instanceof Error ? err.message : err}`, "search");
      results = expandForDocs(allSorted, topK);
    }
  } else {
    // Doc expansion
    results = expandForDocs(allSorted, topK);
  }

  // Log query for analytics
  const durationMs = Math.round(performance.now() - start);
  db.logQuery(
    query,
    results.length,
    results[0]?.score ?? null,
    results[0]?.path ?? null,
    durationMs
  );

  return results;
}

/**
 * Chunk-level search: returns individual semantic chunks ranked by relevance.
 * No file deduplication — two chunks from the same file can both appear.
 */
export async function searchChunks(
  query: string,
  db: RagDB,
  topK: number = 8,
  threshold: number = 0.3,
  hybridWeight: number = DEFAULT_HYBRID_WEIGHT,
  enableReranking: boolean = false
): Promise<ChunkResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  const vectorResults = db.searchChunks(queryEmbedding, topK * 3);

  let textResults: ChunkSearchResult[] = [];
  try {
    textResults = db.textSearchChunks(query, topK * 3);
  } catch (err) {
    log.debug(`FTS chunk query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "search");
  }

  let results = mergeHybridScores(vectorResults, textResults, hybridWeight)
    .filter((r) => r.score >= threshold)
    .map((r) => {
      // Path-based score adjustment for chunks
      const isTest = TEST_PATTERNS.some((p) => p.test(r.path));
      const isSource = SOURCE_PATTERNS.some((p) => p.test(r.path));
      let multiplier = 1.0;
      if (isTest) multiplier = 0.85;
      else if (isSource) multiplier = 1.1;

      // Dependency graph boost for chunks
      const file = db.getFileByPath(r.path);
      let boost = 0;
      if (file) {
        const importerCount = db.getImportersOf(file.id).length;
        if (importerCount > 0) boost = 0.05 * Math.log2(importerCount + 1);
      }

      return { ...r, score: r.score * multiplier + boost };
    })
    .sort((a, b) => b.score - a.score);

  // Cross-encoder reranking: re-score top candidates for precision
  if (enableReranking && results.length > 0) {
    const toRerank = results.slice(0, topK * 2);
    try {
      const passages = toRerank.map((r) => r.content);
      const rerankScores = await rerank(query, passages);
      const reranked = toRerank
        .map((r, i) => ({ ...r, score: rerankScores[i] }))
        .sort((a, b) => b.score - a.score);
      results = expandForDocs(reranked, topK);
    } catch (err) {
      log.warn(`Reranking failed, using hybrid scores: ${err instanceof Error ? err.message : err}`, "search");
      results = expandForDocs(results, topK);
    }
  } else {
    results = expandForDocs(results, topK);
  }

  // Log query for analytics
  const durationMs = Math.round(performance.now() - start);
  db.logQuery(
    query,
    results.length,
    results[0]?.score ?? null,
    results[0]?.path ?? null,
    durationMs
  );

  return results;
}
