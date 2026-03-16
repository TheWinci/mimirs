/**
 * Index excalidraw and benchmark parent chunk promotion impact.
 */
import { resolve, extname } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { RagDB } from "../src/db";
import { loadConfig, applyEmbeddingConfig, type RagConfig } from "../src/config";
import { indexDirectory } from "../src/indexing/indexer";
import { searchChunks, type ChunkResult } from "../src/search/hybrid";
import { chunkFile } from "@winci/bun-chunk";
import { readdirSync } from "fs";

const EXCALIDRAW_DIR = "/Users/winci/repos/excalidraw";
const TMP_DIR = resolve(import.meta.dir, "..", ".rag", "bench-excalidraw");
const TOP_K = 8;

// ── Parent lookup (same as parent-promotion-bench.ts) ──

interface ParentInfo { parentName: string; chunkName: string; chunkType: string; }
type ParentLookup = Map<string, ParentInfo>;

async function buildParentLookup(root: string): Promise<ParentLookup> {
  const lookup: ParentLookup = new Map();
  const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (entry.isFile() && exts.has(extname(entry.name))) files.push(abs);
    }
  }
  walk(root);

  let processed = 0;
  for (const f of files) {
    try {
      const result = await chunkFile(f, { includeContext: true, includeMetadata: true });
      for (const c of result.chunks) {
        if (c.parentName && (c.type === "method" || c.type === "field")) {
          const key = `${resolve(f)}:${c.startLine + 1}`;
          lookup.set(key, { parentName: c.parentName, chunkName: c.name || "unknown", chunkType: c.type });
        }
      }
      processed++;
      if (processed % 100 === 0) process.stdout.write(`  ${processed}/${files.length} files...\r`);
    } catch { /* skip */ }
  }
  console.log(`  Processed ${processed} files`);
  return lookup;
}

// ── Analysis helpers ──

interface ParentGroup {
  parentName: string;
  path: string;
  members: (ChunkResult & { resolvedName?: string })[];
}

function detectParentGroups(results: ChunkResult[], lookup: ParentLookup): ParentGroup[] {
  const groups = new Map<string, ParentGroup>();

  for (const r of results) {
    let parentName: string | null = null;
    let chunkName: string | null = null;

    if (r.entityName?.includes(".")) {
      parentName = r.entityName.split(".")[0];
      chunkName = r.entityName.split(".").slice(1).join(".");
    } else if (r.startLine != null) {
      const key = `${r.path}:${r.startLine}`;
      const info = lookup.get(key);
      if (info) { parentName = info.parentName; chunkName = info.chunkName; }
    }

    if (!parentName) continue;

    const groupKey = `${r.path}::${parentName}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { parentName, path: r.path, members: [] });
    }
    groups.get(groupKey)!.members.push({ ...r, resolvedName: chunkName ?? undefined });
  }

  return [...groups.values()];
}

// ── Queries designed for excalidraw ──

interface TestQuery { query: string; kind: "broad" | "specific"; }

const queries: TestQuery[] = [
  // Broad — should benefit from returning full class
  { query: "linear element editor selection and dragging", kind: "broad" },
  { query: "scene management elements state", kind: "broad" },
  { query: "element delta undo redo changes", kind: "broad" },
  { query: "store snapshot reconciliation", kind: "broad" },
  { query: "font loading and measurement", kind: "broad" },
  { query: "animated trail drawing freehand", kind: "broad" },
  { query: "portal collaboration real-time sync", kind: "broad" },
  { query: "history stack undo redo operations", kind: "broad" },
  { query: "library management import export", kind: "broad" },
  { query: "action manager keyboard shortcuts dispatch", kind: "broad" },

  // Specific — should return focused method
  { query: "handle pointer down event on linear element", kind: "specific" },
  { query: "calculate bounding box for element", kind: "specific" },
  { query: "render element to canvas context", kind: "specific" },
  { query: "serialize scene to JSON export", kind: "specific" },
  { query: "detect collision point in element bounds", kind: "specific" },
  { query: "apply delta changes to element properties", kind: "specific" },
  { query: "load font family from URL", kind: "specific" },
  { query: "create new arrow element binding", kind: "specific" },
  { query: "restore saved scene from local storage", kind: "specific" },
  { query: "calculate midpoint for linear element segment", kind: "specific" },
];

// ── Main ──

async function main() {
  console.log("=== Parent Chunk Promotion — Excalidraw Benchmark ===\n");

  // Index excalidraw (reuse if already indexed)
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = resolve(TMP_DIR, "index.db");

  const config = await loadConfig(EXCALIDRAW_DIR);
  await applyEmbeddingConfig(config);

  const db = new RagDB(dbPath);
  const existingChunks = db.db.query<{ c: number }, []>("SELECT count(*) as c FROM chunks").get()!.c;

  if (existingChunks > 0) {
    console.log(`Reusing existing index (${existingChunks} chunks)\n`);
  } else {
    console.log("Indexing excalidraw...");
    let indexed = 0;
    const result = await indexDirectory(EXCALIDRAW_DIR, db, config, (msg) => {
      if (msg.startsWith("Indexed:")) { indexed++; if (indexed % 50 === 0) process.stdout.write(`  ${indexed} files...\r`); }
    });
    console.log(`\nIndexed: ${result.indexed} files, ${result.skipped} skipped\n`);
  }

  // Check chunk count
  const totalChunks = db.db.query<{ c: number }, []>("SELECT count(*) as c FROM chunks").get()!.c;
  console.log(`Total chunks in DB: ${totalChunks}\n`);

  if (totalChunks === 0) {
    console.log("No chunks indexed — aborting.");
    db.close();
    return;
  }

  // Build parent lookup
  console.log("Building parent lookup from bun-chunk...");
  const lookup = await buildParentLookup(EXCALIDRAW_DIR);
  console.log(`  Found ${lookup.size} sub-chunk entries\n`);

  // Run queries
  const thresholds = [0.4, 0.5, 0.6, 0.7, 0.8];
  let totalResults = 0;
  let totalSubChunks = 0;
  let totalSiblingGroups = 0;
  let totalWastedSlots = 0;
  const promotionByThreshold = new Map<number, number>();
  for (const t of thresholds) promotionByThreshold.set(t, 0);

  for (const q of queries) {
    const results = await searchChunks(q.query, db, TOP_K, 0.3, config.hybridWeight, false);

    const groups = detectParentGroups(results, lookup);
    const subChunkCount = groups.reduce((s, g) => s + g.members.length, 0);
    const siblingGroups = groups.filter((g) => g.members.length > 1);
    const wastedSlots = siblingGroups.reduce((s, g) => s + g.members.length - 1, 0);

    totalResults += results.length;
    totalSubChunks += subChunkCount;
    totalSiblingGroups += siblingGroups.length;
    totalWastedSlots += wastedSlots;

    // Promotion candidates
    for (const t of thresholds) {
      const subs = results.filter((r) => {
        if (r.entityName?.includes(".")) return true;
        if (r.startLine != null) return lookup.has(`${r.path}:${r.startLine}`);
        return false;
      });
      const candidates = subs.filter((r) => r.score >= t).length;
      promotionByThreshold.set(t, promotionByThreshold.get(t)! + candidates);
    }

    // Print per-query details
    const label = q.kind === "broad" ? "BROAD" : "SPEC ";
    const wasteStr = wastedSlots > 0 ? ` ⚠ ${wastedSlots} wasted` : "";
    console.log(`  [${label}] "${q.query}"`);
    console.log(`         ${results.length} results, ${subChunkCount} sub-chunks${wasteStr}`);

    if (siblingGroups.length > 0) {
      for (const g of siblingGroups) {
        const names = g.members.map((m) => m.resolvedName || "?").join(", ");
        const scores = g.members.map((m) => m.score.toFixed(3)).join(", ");
        console.log(`         ↳ ${g.parentName}: ${g.members.length} siblings [${names}] scores: [${scores}]`);
      }
    }
  }

  // Summary
  const pct = (n: number, t: number) => t > 0 ? `${(n / t * 100).toFixed(1)}%` : "0%";

  console.log("\n══════════════════════════════════════");
  console.log("          SUMMARY");
  console.log("══════════════════════════════════════\n");

  console.log(`  Total queries:        ${queries.length} (${queries.filter((q) => q.kind === "broad").length} broad, ${queries.filter((q) => q.kind === "specific").length} specific)`);
  console.log(`  Total results:        ${totalResults}`);
  console.log(`  Sub-chunks in results: ${totalSubChunks} (${pct(totalSubChunks, totalResults)})`);
  console.log(`  Sibling groups:       ${totalSiblingGroups}`);
  console.log(`  Wasted slots:         ${totalWastedSlots} (${pct(totalWastedSlots, totalResults)})`);
  console.log(`  Slot efficiency:      ${pct(totalResults - totalWastedSlots, totalResults)}`);

  console.log("\n  Promotion candidates by threshold:");
  for (const t of thresholds) {
    console.log(`    score ≥ ${t.toFixed(1)}: ${promotionByThreshold.get(t)} (${pct(promotionByThreshold.get(t)!, totalSubChunks)} of sub-chunks)`);
  }

  const wasteRate = totalWastedSlots / totalResults;
  console.log("\n  Verdict:");
  if (wasteRate > 0.15) {
    console.log(`    ✓ HIGH IMPACT: ${(wasteRate * 100).toFixed(1)}% waste → promotion would significantly improve results.`);
  } else if (wasteRate > 0.05) {
    console.log(`    ~ MODERATE IMPACT: ${(wasteRate * 100).toFixed(1)}% waste → promotion provides clear benefit.`);
  } else {
    console.log(`    ✗ LOW IMPACT: ${(wasteRate * 100).toFixed(1)}% waste → marginal improvement.`);
  }

  db.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
