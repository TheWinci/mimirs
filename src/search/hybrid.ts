import { embed } from "../embeddings/embed";
import { RagDB, type SearchResult, type ChunkSearchResult } from "../db";
import { log } from "../utils/log";
import { basename, extname } from "path";

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
  parentId: number | null;
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

// ── Filename-query affinity boost ─────────────────────────────────
// If query words appear in the filename (minus extension), boost the result.
// "scheduler" in query + file named "scheduler.go" → strong signal.
const BOILERPLATE_BASENAMES = new Set([
  "types.go", "doc.go", "types.ts", "types.d.ts", "index.d.ts",
  "constants.go", "defaults.go", "conversion.go",
]);

// ── Generated file demotion ──────────────────────────────────────
// Configurable via "generated" in .mimirs/config.json. Patterns use the same
// glob syntax as "exclude": "**/*.generated.ts", "generated/**",
// "**/zz_generated*", etc.
const GENERATED_DEMOTION = 0.75;

function buildGeneratedMatcher(patterns: string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;

  const dirPrefixes: string[] = [];      // "generated/**" → starts with "generated/"
  const anyDepthDirs: string[] = [];     // "applyconfigurations/**" → /applyconfigurations/ anywhere
  const filenameSuffixes: string[] = []; // "**/*_generated.go" → basename ends with "_generated.go"
  const filenamePatterns: RegExp[] = [];  // "**/zz_generated*" → basename starts with "zz_generated"

  for (const p of patterns) {
    // "dir/**" → directory prefix
    const dirMatch = p.match(/^([^*?]+?)\/?\*\*$/);
    if (dirMatch) {
      const dir = dirMatch[1];
      if (!dir.includes("/")) {
        anyDepthDirs.push(dir);
      } else {
        dirPrefixes.push(dir);
      }
      continue;
    }

    // "**/*_generated.go" → filename ends with suffix
    const suffixMatch = p.match(/^\*\*\/\*([^*?/]+)$/);
    if (suffixMatch) { filenameSuffixes.push(suffixMatch[1]); continue; }

    // "**/zz_generated*" → filename starts with prefix
    const prefixMatch = p.match(/^\*\*\/([^*?/]+)\*$/);
    if (prefixMatch) { filenamePatterns.push(new RegExp(`^${escapeForRegex(prefixMatch[1])}`)); continue; }

    // "**/fake_*" same as above
    // Fallback: treat as regex-safe substring match on full path
    filenamePatterns.push(new RegExp(escapeForRegex(p).replace(/\\\*/g, ".*")));
  }

  return (filePath: string) => {
    for (const prefix of dirPrefixes) {
      if (filePath.startsWith(prefix + "/") || filePath.includes("/" + prefix + "/")) return true;
    }
    for (const dir of anyDepthDirs) {
      if (filePath.startsWith(dir + "/") || filePath.includes("/" + dir + "/")) return true;
    }
    const base = basename(filePath);
    for (const s of filenameSuffixes) {
      if (base.endsWith(s)) return true;
    }
    for (const re of filenamePatterns) {
      if (re.test(base)) return true;
    }
    return false;
  };
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyFilenameBoost(
  results: DedupedResult[],
  query: string,
  isGenerated: (path: string) => boolean,
): DedupedResult[] {
  // Extract meaningful words from query (lowercase, 3+ chars, no stop words)
  const queryWords = query.toLowerCase().split(/[\s_/.-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  if (queryWords.length === 0) return results;

  return results.map((r) => {
    const base = basename(r.path);
    const stem = base.replace(extname(base), "").toLowerCase();

    // Demote boilerplate files — they contain vocabulary but no implementation
    if (BOILERPLATE_BASENAMES.has(base)) {
      return { ...r, score: r.score * 0.8 };
    }
    // Demote generated files (configured via "generated" in config.json)
    if (isGenerated(r.path)) {
      return { ...r, score: r.score * GENERATED_DEMOTION };
    }

    // Boost if query words appear in filename stem
    const stemWords = stem.split(/[_-]+/);
    const stemMatchCount = queryWords.filter((qw) =>
      stemWords.some((sw) => sw === qw || sw.includes(qw) || qw.includes(sw))
    ).length;

    // Boost if query words appear in directory path segments
    // Stricter than filename matching: segment must contain the query word, not vice versa
    // e.g. "podautoscaler" contains "autoscaler" ✓, but "ragdb" contains "db" ✗
    const pathSegments = r.path.toLowerCase().split("/").slice(0, -1); // exclude filename
    const segmentWords = pathSegments.flatMap((seg) => seg.split(/[_.-]+/));
    const pathMatchCount = queryWords.filter((qw) =>
      qw.length >= 3 && segmentWords.some((sw) => sw.length >= 3 && (sw === qw || sw.includes(qw)))
    ).length;

    let boost = 1.0;
    if (stemMatchCount > 0) boost += 0.1 * stemMatchCount;
    if (pathMatchCount > 0) boost += 0.05 * pathMatchCount;

    if (boost > 1.0) {
      return { ...r, score: r.score * boost };
    }

    return r;
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
  // Only expand when docs are displacing code files — if all results are docs,
  // there's nothing to protect and expansion would exceed topK for no reason.
  const codeCount = initial.length - docCount;
  if (docCount === 0 || codeCount === 0) return initial;
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
  generatedPatterns: string[] = [],
): Promise<DedupedResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  // Fetch more than topK to allow deduplication
  const vectorResults = db.search(queryEmbedding, topK * 4);

  // BM25 text search for keyword matching
  let textResults: typeof vectorResults = [];
  try {
    textResults = db.textSearch(query, topK * 4);
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

  // Source file boost (source up, test down) + filename affinity + generated demotion + dependency graph boost
  const isGenerated = buildGeneratedMatcher(generatedPatterns);
  const allSorted = applyGraphBoost(
    applyFilenameBoost(applyPathBoost(Array.from(byFile.values())), query, isGenerated),
    db
  ).sort((a, b) => b.score - a.score);

  // Doc expansion — docs are bonus results, don't displace code
  const results = expandForDocs(allSorted, topK);

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
 * Count-based parent grouping: when ≥2 sub-chunks from the same parent appear
 * in results, replace them all with the parent chunk (keeping highest score).
 * This prevents sibling methods from consuming multiple result slots.
 */
function groupByParent(results: ChunkSearchResult[], db: RagDB, minCount: number = 2): ChunkSearchResult[] {
  // Group children by parentId
  const parentGroups = new Map<number, { members: ChunkSearchResult[]; bestScore: number }>();
  const nonChildren: ChunkSearchResult[] = [];

  for (const r of results) {
    if (r.parentId != null) {
      const group = parentGroups.get(r.parentId);
      if (group) {
        group.members.push(r);
        if (r.score > group.bestScore) group.bestScore = r.score;
      } else {
        parentGroups.set(r.parentId, { members: [r], bestScore: r.score });
      }
    } else {
      nonChildren.push(r);
    }
  }

  // Replace groups that meet the threshold with parent chunk
  const promoted: ChunkSearchResult[] = [];
  const keptChildren: ChunkSearchResult[] = [];
  const parentCache = new Map<number, ReturnType<typeof db.getChunkById>>();

  for (const [parentId, group] of parentGroups) {
    if (group.members.length >= minCount) {
      // Fetch parent chunk
      if (!parentCache.has(parentId)) {
        parentCache.set(parentId, db.getChunkById(parentId));
      }
      const parent = parentCache.get(parentId);
      if (parent) {
        // Check if parent chunk itself is already in nonChildren (avoid duplication)
        const parentAlreadyPresent = nonChildren.some(
          (r) => r.path === parent.path && r.startLine === parent.startLine && r.endLine === parent.endLine
        );
        if (!parentAlreadyPresent) {
          promoted.push({
            path: parent.path,
            score: group.bestScore,
            content: parent.snippet,
            chunkIndex: -1,
            entityName: parent.entityName,
            chunkType: parent.chunkType,
            startLine: parent.startLine,
            endLine: parent.endLine,
            parentId: null,
          });
        }
      } else {
        // Parent not found in DB — keep children as-is
        keptChildren.push(...group.members);
      }
    } else {
      // Below count threshold — keep children individually
      keptChildren.push(...group.members);
    }
  }

  return [...nonChildren, ...promoted, ...keptChildren].sort((a, b) => b.score - a.score);
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
  generatedPatterns: string[] = [],
): Promise<ChunkResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  const vectorResults = db.searchChunks(queryEmbedding, topK * 4);

  let textResults: ChunkSearchResult[] = [];
  try {
    textResults = db.textSearchChunks(query, topK * 4);
  } catch (err) {
    log.debug(`FTS chunk query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "search");
  }

  const isGenerated = buildGeneratedMatcher(generatedPatterns);
  let results = mergeHybridScores(vectorResults, textResults, hybridWeight)
    .filter((r) => r.score >= threshold)
    .map((r) => {
      // Path-based score adjustment for chunks
      const isTest = TEST_PATTERNS.some((p) => p.test(r.path));
      const isSource = SOURCE_PATTERNS.some((p) => p.test(r.path));
      let multiplier = 1.0;
      if (isTest) multiplier = 0.85;
      else if (isSource) multiplier = 1.1;

      // Filename affinity + boilerplate/generated demotion for chunks
      const base = basename(r.path);
      const stem = base.replace(extname(base), "").toLowerCase();
      if (BOILERPLATE_BASENAMES.has(base)) {
        multiplier *= 0.8;
      } else if (isGenerated(r.path)) {
        multiplier *= GENERATED_DEMOTION;
      } else {
        const queryWords = query.toLowerCase().split(/[\s_/.-]+/)
          .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
        const stemWords = stem.split(/[_-]+/);
        const stemMatchCount = queryWords.filter((qw) =>
          stemWords.some((sw) => sw === qw || sw.includes(qw) || qw.includes(sw))
        ).length;
        const pathSegments = r.path.toLowerCase().split("/").slice(0, -1);
        const segmentWords = pathSegments.flatMap((seg) => seg.split(/[_.-]+/));
        const pathMatchCount = queryWords.filter((qw) =>
          qw.length >= 3 && segmentWords.some((sw) => sw.length >= 3 && (sw === qw || sw.includes(qw)))
        ).length;
        if (stemMatchCount > 0) multiplier *= 1.0 + 0.1 * stemMatchCount;
        if (pathMatchCount > 0) multiplier *= 1.0 + 0.05 * pathMatchCount;
      }

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

  // Parent grouping: if ≥2 sub-chunks from the same parent appear, consolidate
  results = groupByParent(results, db);

  // Doc expansion
  results = expandForDocs(results, topK);

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
