import { embed } from "../embeddings/embed";
import { RagDB, type SearchResult, type ChunkSearchResult } from "../db";

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

export async function search(
  query: string,
  db: RagDB,
  topK: number = 5,
  threshold: number = 0,
  hybridWeight: number = DEFAULT_HYBRID_WEIGHT
): Promise<DedupedResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  // Fetch more than topK to allow deduplication
  const vectorResults = db.search(queryEmbedding, topK * 3);

  // BM25 text search for keyword matching
  let textResults: typeof vectorResults = [];
  try {
    textResults = db.textSearch(query, topK * 3);
  } catch {
    // FTS query may fail on special characters — fall back to vector-only
  }

  // Merge scores: hybridWeight * vector + (1 - hybridWeight) * bm25
  const scoreMap = new Map<string, { vectorScore: number; textScore: number; snippet: string; path: string }>();

  for (const r of vectorResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    scoreMap.set(key, { vectorScore: r.score, textScore: 0, snippet: r.snippet, path: r.path });
  }

  for (const r of textResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.textScore = r.score;
    } else {
      scoreMap.set(key, { vectorScore: 0, textScore: r.score, snippet: r.snippet, path: r.path });
    }
  }

  const merged = Array.from(scoreMap.values()).map((r) => ({
    path: r.path,
    score: hybridWeight * r.vectorScore + (1 - hybridWeight) * r.textScore,
    snippet: r.snippet,
  }));

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

  // Sort by score descending, take topK files
  const results = Array.from(byFile.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

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
  hybridWeight: number = DEFAULT_HYBRID_WEIGHT
): Promise<ChunkResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  const vectorResults = db.searchChunks(queryEmbedding, topK * 3);

  let textResults: ChunkSearchResult[] = [];
  try {
    textResults = db.textSearchChunks(query, topK * 3);
  } catch {
    // FTS query may fail on special characters
  }

  // Merge scores per chunk (keyed by path:chunkIndex)
  const scoreMap = new Map<string, {
    vectorScore: number;
    textScore: number;
    path: string;
    content: string;
    chunkIndex: number;
    entityName: string | null;
    chunkType: string | null;
    startLine: number | null;
    endLine: number | null;
  }>();

  for (const r of vectorResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    scoreMap.set(key, {
      vectorScore: r.score,
      textScore: 0,
      path: r.path,
      content: r.content,
      chunkIndex: r.chunkIndex,
      entityName: r.entityName,
      chunkType: r.chunkType,
      startLine: r.startLine,
      endLine: r.endLine,
    });
  }

  for (const r of textResults) {
    const key = `${r.path}:${r.chunkIndex}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.textScore = r.score;
    } else {
      scoreMap.set(key, {
        vectorScore: 0,
        textScore: r.score,
        path: r.path,
        content: r.content,
        chunkIndex: r.chunkIndex,
        entityName: r.entityName,
        chunkType: r.chunkType,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
  }

  const results = Array.from(scoreMap.values())
    .map((r) => ({
      path: r.path,
      score: hybridWeight * r.vectorScore + (1 - hybridWeight) * r.textScore,
      content: r.content,
      chunkIndex: r.chunkIndex,
      entityName: r.entityName,
      chunkType: r.chunkType,
      startLine: r.startLine,
      endLine: r.endLine,
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

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
