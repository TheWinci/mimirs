/**
 * Benchmark: parent chunk promotion impact analysis.
 *
 * Runs chunk-level search (searchChunks) on two kinds of queries:
 *   - "broad" queries that should ideally return a full class/entity
 *   - "specific" queries that should ideally return a single method/chunk
 *
 * Since entity_name is currently broken for sub-chunks (methods have no
 * exports, so parentName isn't stored), this benchmark uses a lookup table
 * built from bun-chunk output to detect which result chunks are sub-chunks.
 *
 * Measures:
 *   1. Sibling waste: how often multiple sub-chunks from the same parent
 *      appear in results (promotion would consolidate these)
 *   2. Promotion candidates: how many sub-chunk results score above
 *      various thresholds (0.5, 0.6, 0.7, 0.8)
 *   3. Slot efficiency: what % of result slots are "wasted" on siblings
 *   4. Context coverage: for broad queries, what fraction of the parent
 *      entity's line range is covered by returned sub-chunks
 */
import { resolve, relative } from "path";
import { RagDB } from "../src/db";
import { loadConfig, applyEmbeddingConfig } from "../src/config";
import { searchChunks, type ChunkResult } from "../src/search/hybrid";
import { chunkFile } from "@winci/bun-chunk";
import { readdirSync, statSync } from "fs";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const TOP_K = 8;

// ── Build parent lookup from bun-chunk ──

interface ParentInfo {
  parentName: string;
  chunkName: string;
  chunkType: string;
}

/** Map from "relativePath:startLine" → parent info */
type ParentLookup = Map<string, ParentInfo>;

async function buildParentLookup(): Promise<ParentLookup> {
  const lookup: ParentLookup = new Map();
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      const ext = abs.slice(abs.lastIndexOf("."));
      if (exts.has(ext)) {
        // Will be processed below
        (walk as any).__files = (walk as any).__files || [];
        (walk as any).__files.push(abs);
      }
    }
  }
  walk(PROJECT_DIR);
  const files: string[] = (walk as any).__files || [];

  for (const absPath of files) {
    try {
      const result = await chunkFile(absPath, { includeContext: true, includeMetadata: true });
      const relPath = resolve(absPath); // absolute for matching with DB paths
      for (const c of result.chunks) {
        if (c.parentName && (c.type === "method" || c.type === "field")) {
          // bun-chunk uses 0-indexed lines, mimirs uses 1-indexed
          const key = `${relPath}:${c.startLine + 1}`;
          lookup.set(key, {
            parentName: c.parentName,
            chunkName: c.name || "unknown",
            chunkType: c.type,
          });
        }
      }
    } catch {
      // Skip files that can't be chunked
    }
  }

  return lookup;
}

// ── Test queries ──

interface TestQuery {
  query: string;
  kind: "broad" | "specific";
  /** Expected parent entity name (for broad) or method name (for specific) */
  expectedEntity?: string;
}

const queries: TestQuery[] = [
  // Broad queries — should ideally return the full class
  { query: "RagDB database class with all its methods", kind: "broad", expectedEntity: "RagDB" },
  { query: "hybrid search implementation combining vector and text", kind: "broad", expectedEntity: "hybrid" },
  { query: "file indexing and processing pipeline", kind: "broad", expectedEntity: "indexer" },
  { query: "AST chunking for source code files", kind: "broad", expectedEntity: "chunker" },
  { query: "embedding model loading and batch processing", kind: "broad", expectedEntity: "embed" },
  { query: "MCP server tool registration and handling", kind: "broad", expectedEntity: "server" },
  { query: "configuration loading and validation schema", kind: "broad", expectedEntity: "config" },
  { query: "dependency graph import resolution", kind: "broad", expectedEntity: "resolver" },

  // Specific queries — should return a focused sub-chunk
  { query: "vectorSearchChunks cosine distance query", kind: "specific", expectedEntity: "vectorSearchChunks" },
  { query: "mergeHybridScores combine vector and text scores", kind: "specific", expectedEntity: "mergeHybridScores" },
  { query: "upsertFileStart insert or update file hash", kind: "specific", expectedEntity: "upsertFileStart" },
  { query: "embedBatchMerged token windowing oversized", kind: "specific", expectedEntity: "embedBatchMerged" },
  { query: "splitMarkdown heading level section", kind: "specific", expectedEntity: "splitMarkdown" },
  { query: "rerank cross-encoder ms-marco scoring", kind: "specific", expectedEntity: "rerank" },
  { query: "deleteStaleChunks remove old content hashes", kind: "specific", expectedEntity: "deleteStaleChunks" },
  { query: "logQuery analytics duration tracking", kind: "specific", expectedEntity: "logQuery" },
];

// ── Analysis ──

interface ParentGroup {
  parentName: string;
  path: string;
  members: (ChunkResult & { resolvedParent?: string; resolvedName?: string })[];
  minLine: number;
  maxLine: number;
}

function detectParentGroups(results: ChunkResult[], lookup: ParentLookup): ParentGroup[] {
  const groups = new Map<string, ParentGroup>();

  for (const r of results) {
    // Try dotted entity name first, then fall back to bun-chunk lookup
    let parentName: string | null = null;
    let chunkName: string | null = null;

    if (r.entityName?.includes(".")) {
      parentName = r.entityName.split(".")[0];
      chunkName = r.entityName.split(".").slice(1).join(".");
    } else if (r.startLine != null) {
      const key = `${r.path}:${r.startLine}`;
      const info = lookup.get(key);
      if (info) {
        parentName = info.parentName;
        chunkName = info.chunkName;
      }
    }

    if (!parentName) continue;

    const groupKey = `${r.path}::${parentName}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        parentName,
        path: r.path,
        members: [],
        minLine: r.startLine ?? Infinity,
        maxLine: r.endLine ?? 0,
      });
    }
    const g = groups.get(groupKey)!;
    g.members.push({ ...r, resolvedParent: parentName, resolvedName: chunkName ?? undefined });
    if (r.startLine != null) g.minLine = Math.min(g.minLine, r.startLine);
    if (r.endLine != null) g.maxLine = Math.max(g.maxLine, r.endLine);
  }

  return [...groups.values()];
}

function analyzeSiblingWaste(results: ChunkResult[], lookup: ParentLookup): {
  totalResults: number;
  subChunkCount: number;
  siblingGroups: number;
  wastedSlots: number;
  slotEfficiency: number;
} {
  const groups = detectParentGroups(results, lookup);
  const subChunkCount = groups.reduce((s, g) => s + g.members.length, 0);
  const siblingGroups = groups.filter((g) => g.members.length > 1);
  const wastedSlots = siblingGroups.reduce((s, g) => s + g.members.length - 1, 0);

  return {
    totalResults: results.length,
    subChunkCount,
    siblingGroups: siblingGroups.length,
    wastedSlots,
    slotEfficiency: results.length > 0
      ? (results.length - wastedSlots) / results.length
      : 1,
  };
}

function analyzePromotionCandidates(
  results: ChunkResult[],
  thresholds: number[],
  lookup: ParentLookup,
): Map<number, { candidates: number; total: number }> {
  // Identify sub-chunks via lookup
  const subChunks = results.filter((r) => {
    if (r.entityName?.includes(".")) return true;
    if (r.startLine != null) {
      const key = `${r.path}:${r.startLine}`;
      return lookup.has(key);
    }
    return false;
  });
  const map = new Map<number, { candidates: number; total: number }>();

  for (const t of thresholds) {
    const candidates = subChunks.filter((r) => r.score >= t).length;
    map.set(t, { candidates, total: subChunks.length });
  }

  return map;
}

// ── Main ──

async function main() {
  console.log("=== Parent Chunk Promotion — Impact Analysis ===\n");

  const config = await loadConfig(PROJECT_DIR);
  await applyEmbeddingConfig(config);

  const db = new RagDB(PROJECT_DIR);

  console.log("Building parent lookup from bun-chunk...");
  const lookup = await buildParentLookup();
  console.log(`  Found ${lookup.size} sub-chunk entries across project\n`);

  const thresholds = [0.4, 0.5, 0.6, 0.7, 0.8];

  // Aggregate stats
  let totalSiblingGroups = 0;
  let totalWastedSlots = 0;
  let totalResults = 0;
  let totalSubChunks = 0;
  const promotionByThreshold = new Map<number, number>();
  for (const t of thresholds) promotionByThreshold.set(t, 0);

  const broadResults: { query: string; waste: ReturnType<typeof analyzeSiblingWaste>; results: ChunkResult[] }[] = [];
  const specificResults: { query: string; waste: ReturnType<typeof analyzeSiblingWaste>; results: ChunkResult[] }[] = [];

  for (const q of queries) {
    const results = await searchChunks(
      q.query,
      db,
      TOP_K,
      0.3,
      config.hybridWeight,
      false, // no reranking for consistency
    );

    const waste = analyzeSiblingWaste(results, lookup);
    const promotions = analyzePromotionCandidates(results, thresholds, lookup);

    totalSiblingGroups += waste.siblingGroups;
    totalWastedSlots += waste.wastedSlots;
    totalResults += results.length;
    totalSubChunks += waste.subChunkCount;

    for (const [t, { candidates }] of promotions) {
      promotionByThreshold.set(t, promotionByThreshold.get(t)! + candidates);
    }

    if (q.kind === "broad") {
      broadResults.push({ query: q.query, waste, results });
    } else {
      specificResults.push({ query: q.query, waste, results });
    }
  }

  // ── Report ──

  console.log("── Overall Statistics ──\n");
  console.log(`  Total queries:       ${queries.length} (${queries.filter((q) => q.kind === "broad").length} broad, ${queries.filter((q) => q.kind === "specific").length} specific)`);
  console.log(`  Total results:       ${totalResults}`);
  console.log(`  Sub-chunks in results: ${totalSubChunks} (${pct(totalSubChunks, totalResults)})`);
  console.log(`  Sibling groups:      ${totalSiblingGroups} (groups of ≥2 sub-chunks from same parent)`);
  console.log(`  Wasted slots:        ${totalWastedSlots} (${pct(totalWastedSlots, totalResults)})`);
  console.log(`  Slot efficiency:     ${((totalResults - totalWastedSlots) / totalResults * 100).toFixed(1)}%`);

  console.log("\n── Promotion Candidates by Threshold ──\n");
  for (const t of thresholds) {
    const count = promotionByThreshold.get(t)!;
    console.log(`  score ≥ ${t.toFixed(1)}: ${count} sub-chunks promotable (${pct(count, totalSubChunks)} of sub-chunks)`);
  }

  console.log("\n── Broad Queries (should benefit from promotion) ──\n");
  for (const { query, waste, results } of broadResults) {
    const groups = detectParentGroups(results, lookup);
    const siblings = groups.filter((g) => g.members.length > 1);

    console.log(`  Q: "${query}"`);
    console.log(`     ${results.length} results, ${waste.subChunkCount} sub-chunks, ${waste.wastedSlots} wasted slots, efficiency: ${(waste.slotEfficiency * 100).toFixed(0)}%`);

    if (siblings.length > 0) {
      for (const g of siblings) {
        const scores = g.members.map((m) => m.score.toFixed(3)).join(", ");
        const methods = g.members.map((m) => m.resolvedName || "?").join(", ");
        console.log(`     ↳ ${g.parentName} (${g.path.split("/").pop()}): ${g.members.length} siblings [${methods}] scores: [${scores}]`);
      }
    }

    // Show top 3 results
    for (const r of results.slice(0, 3)) {
      const entity = r.entityName ? ` • ${r.entityName}` : "";
      const lines = r.startLine && r.endLine ? `:${r.startLine}-${r.endLine}` : "";
      console.log(`     [${r.score.toFixed(3)}] ${r.path.split("/").pop()}${lines}${entity}`);
    }
    console.log();
  }

  console.log("── Specific Queries (should NOT be hurt by promotion) ──\n");
  for (const { query, waste, results } of specificResults) {
    console.log(`  Q: "${query}"`);
    console.log(`     ${results.length} results, ${waste.wastedSlots} wasted slots`);

    for (const r of results.slice(0, 3)) {
      const entity = r.entityName ? ` • ${r.entityName}` : "";
      const lines = r.startLine && r.endLine ? `:${r.startLine}-${r.endLine}` : "";
      console.log(`     [${r.score.toFixed(3)}] ${r.path.split("/").pop()}${lines}${entity}`);
    }
    console.log();
  }

  // ── Summary verdict ──
  console.log("══════════════════════════════════════");
  console.log("          VERDICT");
  console.log("══════════════════════════════════════\n");

  const wasteRate = totalWastedSlots / totalResults;
  if (wasteRate > 0.15) {
    console.log(`  ✓ HIGH IMPACT: ${(wasteRate * 100).toFixed(1)}% of result slots wasted on siblings.`);
    console.log(`    Parent promotion would free ~${totalWastedSlots} slots across ${queries.length} queries.`);
  } else if (wasteRate > 0.05) {
    console.log(`  ~ MODERATE IMPACT: ${(wasteRate * 100).toFixed(1)}% of result slots wasted on siblings.`);
    console.log(`    Parent promotion provides some benefit.`);
  } else {
    console.log(`  ✗ LOW IMPACT: Only ${(wasteRate * 100).toFixed(1)}% of result slots wasted on siblings.`);
    console.log(`    Parent promotion may not be worth the complexity.`);
  }

  db.close();
  console.log("\nDone.");
}

function pct(n: number, total: number): string {
  return total > 0 ? `${(n / total * 100).toFixed(1)}%` : "0%";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
