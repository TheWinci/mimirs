import { embed } from "../embeddings/embed";
import { RagDB, type SearchResult, type ChunkSearchResult, type PathFilter } from "../db";
import { vectorScoreToCosine } from "../db/search";
import { log } from "../utils/log";
import { TEST_PATTERNS } from "../utils/test-paths";
import { basename, extname } from "path";

/**
 * Match a path against a PathFilter — used in-memory to filter results that
 * bypassed SQL (e.g. symbol-expanded hits). Mirrors buildPathFilter in db/search.ts.
 */
function matchesFilter(path: string, filter?: PathFilter): boolean {
  if (!filter) return true;

  if (filter.extensions && filter.extensions.length > 0) {
    const ok = filter.extensions.some((ext) => {
      const normalized = ext.startsWith(".") ? ext : `.${ext}`;
      return path.endsWith(normalized);
    });
    if (!ok) return false;
  }

  if (filter.dirs && filter.dirs.length > 0) {
    const ok = filter.dirs.some((dir) => {
      const normalized = dir.replace(/\/$/, "") + "/";
      return path.startsWith(normalized);
    });
    if (!ok) return false;
  }

  if (filter.excludeDirs && filter.excludeDirs.length > 0) {
    for (const dir of filter.excludeDirs) {
      const normalized = dir.replace(/\/$/, "") + "/";
      if (path.startsWith(normalized)) return false;
    }
  }

  return true;
}

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

// 0.5 = equal weight to the semantic (vector) and lexical (BM25) rank signals.
// A sweep over keyword and purely-semantic query sets put the optimum here:
// keyword queries hit 100% recall and semantic queries peak (recall collapses
// below ~0.3 as vector signal is starved). See benchmarks/semantic-sweep.ts.
export const DEFAULT_HYBRID_WEIGHT = 0.5;

/**
 * Reciprocal-rank fusion of two result lists already sorted best-first.
 *
 * Vector (cosine) and text (BM25-derived 1/(1+|rank|)) scores live on different,
 * non-comparable scales, so a raw linear blend is dominated by whichever has the
 * larger magnitude — making the weight nearly inert and (for BM25) the score is
 * even inverted. Fuse by RANK instead: each list contributes K/(K+rank) in (0,1]
 * (1 at rank 0), blended by `weight` toward the primary list. Scale-free, keeps
 * scores compressed near the top (so downstream boosts still rank), and dedups
 * across lists by `key`. The single source of truth for all hybrid fusion —
 * chunk search and conversation search both go through here.
 */
export function rrfFuse<T extends { score: number }>(
  primary: T[],
  secondary: T[],
  weight: number,
  key: (item: T) => string | number,
): T[] {
  const RRF_K = 60;
  const ranks = (list: T[]): Map<string | number, number> => {
    const m = new Map<string | number, number>();
    list.forEach((r, i) => m.set(key(r), RRF_K / (RRF_K + i)));
    return m;
  };
  const primaryRank = ranks(primary);
  const secondaryRank = ranks(secondary);

  const items = new Map<string | number, T>();
  for (const r of primary) items.set(key(r), r);
  for (const r of secondary) {
    const k = key(r);
    if (!items.has(k)) items.set(k, r);
  }

  return Array.from(items.entries()).map(([k, item]) => ({
    ...item,
    score: weight * (primaryRank.get(k) ?? 0) + (1 - weight) * (secondaryRank.get(k) ?? 0),
  }));
}

/**
 * Merge chunk vector and text search results using hybrid rank fusion.
 * Each result must have `score`, `path`, and `chunkIndex`.
 */
export function mergeHybridScores<T extends { score: number; path: string; chunkIndex: number }>(
  vectorResults: T[],
  textResults: T[],
  hybridWeight: number
): T[] {
  return rrfFuse(vectorResults, textResults, hybridWeight, (r) => `${r.path}:${r.chunkIndex}`);
}

// ── Source file boost ────────────────────────────────────────────
// Test patterns live in ../utils/test-paths (shared with the impact tool).
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
      existing.score *= 1.3;
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
  // Extend until the original code-slot count is restored — the extension
  // slots can themselves be docs, so a fixed +docCount could still come up
  // short on code results. Hard cap at 2×topK: in docs-heavy pools an
  // unbounded walk returned the entire 8×topK candidate pool.
  const cap = Math.min(pool.length, topK * 2);
  let end = topK;
  let codes = codeCount;
  while (codes < topK && end < cap) {
    if (!DOC_EXTENSIONS.test(pool[end].path)) codes++;
    end++;
  }
  return pool.slice(0, end);
}

// ── Dependency graph boost ───────────────────────────────────────
function applyGraphBoost(results: DedupedResult[], db: RagDB): DedupedResult[] {
  return results.map((r) => {
    const file = db.getFileByPath(r.path);
    if (!file) return r;
    const importerCount = db.getImportersOf(file.id).length;
    if (importerCount === 0) return r;
    // Modest logarithmic boost: a file imported by 8 others gets +0.15. Swept on
    // ContextBench — 0.05 is the peak (higher buries gold under well-imported hubs).
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
  filter?: PathFilter,
): Promise<DedupedResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  // Fetch more than topK to allow deduplication
  const vectorResults = db.search(queryEmbedding, topK * 4, filter);

  // BM25 text search for keyword matching
  let textResults: typeof vectorResults = [];
  try {
    textResults = db.textSearch(query, topK * 4, filter);
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
        if (matchesFilter(s.path, filter)) {
          symbolHits.push({ path: s.path, snippet: s.snippet });
        }
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

  // Log query for analytics. The result score is now a positional rank-fusion
  // value (~1 at the top), so log the top vector hit's cosine similarity as the
  // relevance signal instead — that keeps "avg top score" and the low-relevance
  // (< 0.3) heuristic on a true cosine scale. The stored vector score is L2-based
  // (1/(1+distance)) and bottoms out near 0.33, so logging it raw would make the
  // < 0.3 heuristic dead; vectorScoreToCosine converts it back.
  const durationMs = Math.round(performance.now() - start);
  db.logQuery(
    query,
    results.length,
    vectorScoreToCosine(vectorResults[0]?.score),
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
  filter?: PathFilter,
  parentGroupingMinCount: number = 2,
  leafOnly: boolean = false,
  symbolExpand: boolean = false,
  // Whole-class boost: lift each leaf by its file's parent-blob match score × this.
  // A chunk whose enclosing class/file matched as a whole is more likely relevant.
  parentBoost: number = 0,
  // Adaptive tail cut: after ranking, keep only chunks scoring >= anchor*relCutoff,
  // where the anchor is the score the curve SETTLES at — found by skipping steep
  // head steps (Δ% > steepSkip) so a single inflated top result can't set the bar
  // too high. relCutoff=0 disables. Trims the weak tail for precision.
  relCutoff: number = 0,
  steepSkip: number = 0.15,
): Promise<ChunkResult[]> {
  const start = performance.now();
  const queryEmbedding = await embed(query);

  let vectorResults = db.searchChunks(queryEmbedding, topK * 4, filter);

  let textResults: ChunkSearchResult[] = [];
  try {
    textResults = db.textSearchChunks(query, topK * 4, filter);
  } catch (err) {
    log.debug(`FTS chunk query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "search");
  }

  // Whole-class boost (parentBoost): instead of just discarding the whole-class/file
  // parent blobs, use how well the blob matched as a per-file signal.
  let parentScoreByPath: Map<string, number> | undefined;
  if (parentBoost > 0) {
    const vP = vectorResults.filter((r) => r.chunkIndex === -1);
    const tP = textResults.filter((r) => r.chunkIndex === -1);
    parentScoreByPath = new Map<string, number>();
    for (const p of mergeHybridScores(vP, tP, hybridWeight)) {
      parentScoreByPath.set(p.path, Math.max(parentScoreByPath.get(p.path) ?? 0, p.score));
    }
  }

  // Leaf-only: drop synthetic parent rows (chunk_index === -1, whole class/file
  // concatenations) so retrieval returns tight function-level spans. Children
  // carry the same lines, so coverage is preserved while context/token cost drops.
  if (leafOnly) {
    vectorResults = vectorResults.filter((r) => r.chunkIndex !== -1);
    textResults = textResults.filter((r) => r.chunkIndex !== -1);
  }

  // `threshold` is documented as a 0-1 relevance score, but fused scores are
  // positional RRF values (single-list max = weight ≤ 1, decaying fast) — the
  // two scales diverged in the RRF migration and a user passing e.g. 0.5
  // silently filtered out almost everything. Compare against the TRUE cosine
  // of the vector match instead — but only for VECTOR-ONLY rows: a keyword
  // match is its own relevance signal, and filtering rows that matched BOTH
  // ways (weak cosine + strong keyword) made adding semantic signal strictly
  // worse than having none.
  const cosineByKey = new Map<string, number | null>();
  for (const v of vectorResults) {
    cosineByKey.set(`${v.path}:${v.chunkIndex}`, vectorScoreToCosine(v.score));
  }
  const textKeys = new Set(textResults.map((t) => `${t.path}:${t.chunkIndex}`));

  const isGenerated = buildGeneratedMatcher(generatedPatterns);
  let results = mergeHybridScores(vectorResults, textResults, hybridWeight)
    .filter((r) => {
      const key = `${r.path}:${r.chunkIndex}`;
      if (textKeys.has(key)) return true; // keyword-matched — keep
      const cos = cosineByKey.get(key);
      return cos == null || cos >= threshold;
    })
    .map((r) => {
      // Path-based score adjustment for chunks: demote tests. (We deliberately do
      // NOT bump a hardcoded src/lib/... whitelist — it's not generic and measured
      // as adding nothing; cross-helper agreement is already captured by the RRF
      // fusion, so re-boosting it double-counts.)
      const isTest = TEST_PATTERNS.some((p) => p.test(r.path));
      let multiplier = 1.0;
      if (isTest) multiplier = 0.85;

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

      // Parent rows (chunkIndex === -1, kept when leafOnly=false) must not
      // self-boost from their own match score — that ranked every parent above
      // its children and defeated the tight-spans goal.
      const pBoost = parentScoreByPath && r.chunkIndex !== -1
        ? (parentScoreByPath.get(r.path) ?? 0) * parentBoost
        : 0;
      return { ...r, score: r.score * multiplier + boost + pBoost };
    })
    .sort((a, b) => b.score - a.score);

  // Symbol expansion (port of search()'s file-level symbol injection to the chunk
  // path): when the query names code identifiers, inject the defining symbol's
  // chunk. Surfaces named helpers (e.g. rotation_matrix -> matrix_utilities) that
  // pure semantic chunk search misses — high-signal exact-name hits.
  if (symbolExpand) {
    const identifiers = extractIdentifiers(query);
    const seen = new Set(results.map((r) => `${r.path}:${r.chunkIndex}`));
    const injected: ChunkResult[] = [];
    for (const id of identifiers) {
      for (const s of db.searchSymbols(id, true, undefined, 3)) {
        if (!matchesFilter(s.path, filter)) continue;
        const ci = s.chunkIndex ?? 0;
        if (leafOnly && ci === -1) continue;
        const key = `${s.path}:${ci}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const f = db.getFileByPath(s.path);
        const range = f ? db.getCallableRange(f.id, s.symbolName) : null;
        injected.push({
          path: s.path,
          score: 0.75, // exact name hit — high base, like search()'s symbol-only score
          content: s.snippet ?? "",
          chunkIndex: ci,
          entityName: s.symbolName,
          chunkType: s.symbolType,
          startLine: range?.startLine ?? null,
          endLine: range?.endLine ?? null,
          parentId: null,
        });
      }
    }
    if (injected.length) results = [...results, ...injected].sort((a, b) => b.score - a.score);
  }

  // Parent grouping: if ≥minCount sub-chunks from the same parent appear, consolidate.
  // Skipped in leaf-only mode (we want tight child spans, not promoted parents).
  if (!leafOnly) results = groupByParent(results, db, parentGroupingMinCount);

  // Doc expansion
  results = expandForDocs(results, topK);

  // Adaptive tail cut: drop chunks below anchor*relCutoff, where the anchor is the
  // score the curve SETTLES at — skip steep head steps (Δ% > steepSkip) so a lone
  // inflated top result doesn't set the bar too high. Trims the weak tail (fewer,
  // tighter spans → higher precision) while keeping the confident head.
  if (relCutoff > 0 && results.length > 1) {
    let anchor = results[0].score;
    for (let i = 1; i < results.length; i++) {
      const dp = results[i - 1].score > 0 ? (results[i - 1].score - results[i].score) / results[i - 1].score : 0;
      if (dp > steepSkip) anchor = results[i].score; else break;
    }
    const floor = anchor * relCutoff;
    results = results.filter((r) => r.score >= floor);
  }

  // Log query for analytics — log the top vector hit's cosine similarity as the
  // relevance signal (the result score is now a positional rank-fusion value).
  // The stored vector score is L2-based and bottoms out near 0.33, so convert it
  // back to cosine to keep the low-relevance (< 0.3) heuristic meaningful.
  const durationMs = Math.round(performance.now() - start);
  db.logQuery(
    query,
    results.length,
    vectorScoreToCosine(vectorResults[0]?.score),
    results[0]?.path ?? null,
    durationMs
  );

  return results;
}
