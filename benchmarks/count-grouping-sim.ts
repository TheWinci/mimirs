/**
 * Simulate count-based parent grouping on both local-rag and excalidraw.
 *
 * Rule: if ≥2 sub-chunks from the same parent appear in top-K results,
 * replace them all with one parent chunk (keeping the highest score).
 *
 * Measures: freed slots, diversity gain, score distribution changes.
 */
import { resolve, extname } from "path";
import { existsSync, readdirSync } from "fs";
import { RagDB } from "../src/db";
import { loadConfig, applyEmbeddingConfig } from "../src/config";
import { searchChunks, type ChunkResult } from "../src/search/hybrid";
import { chunkFile } from "@winci/bun-chunk";

// ── Config ──

interface Project {
  name: string;
  dir: string;
  dbPath: string;
  queries: { query: string; kind: "broad" | "specific" }[];
}

const projects: Project[] = [
  {
    name: "local-rag",
    dir: resolve(import.meta.dir, ".."),
    dbPath: resolve(import.meta.dir, ".."),
    queries: [
      { query: "RagDB database class with all its methods", kind: "broad" },
      { query: "hybrid search implementation combining vector and text", kind: "broad" },
      { query: "file indexing and processing pipeline", kind: "broad" },
      { query: "embedding model loading and batch processing", kind: "broad" },
      { query: "configuration loading and validation schema", kind: "broad" },
      { query: "dependency graph import resolution", kind: "broad" },
      { query: "vectorSearchChunks cosine distance query", kind: "specific" },
      { query: "upsertFileStart insert or update file hash", kind: "specific" },
      { query: "deleteStaleChunks remove old content hashes", kind: "specific" },
      { query: "logQuery analytics duration tracking", kind: "specific" },
      { query: "mergeHybridScores combine vector and text scores", kind: "specific" },
      { query: "embedBatchMerged token windowing oversized", kind: "specific" },
    ],
  },
  {
    name: "excalidraw",
    dir: "/Users/winci/repos/excalidraw",
    dbPath: resolve(import.meta.dir, "..", ".rag", "bench-excalidraw", "index.db"),
    queries: [
      { query: "linear element editor selection and dragging", kind: "broad" },
      { query: "scene management elements state", kind: "broad" },
      { query: "element delta undo redo changes", kind: "broad" },
      { query: "store snapshot reconciliation", kind: "broad" },
      { query: "font loading and measurement", kind: "broad" },
      { query: "animated trail drawing freehand", kind: "broad" },
      { query: "history stack undo redo operations", kind: "broad" },
      { query: "action manager keyboard shortcuts dispatch", kind: "broad" },
      { query: "handle pointer down event on linear element", kind: "specific" },
      { query: "calculate bounding box for element", kind: "specific" },
      { query: "apply delta changes to element properties", kind: "specific" },
      { query: "load font family from URL", kind: "specific" },
      { query: "render element to canvas context", kind: "specific" },
      { query: "calculate midpoint for linear element segment", kind: "specific" },
    ],
  },
];

// ── Parent lookup ──

type ParentLookup = Map<string, { parentName: string; chunkName: string }>;

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

  for (const f of files) {
    try {
      const result = await chunkFile(f, { includeContext: true, includeMetadata: true });
      for (const c of result.chunks) {
        if (c.parentName && (c.type === "method" || c.type === "field")) {
          lookup.set(`${resolve(f)}:${c.startLine + 1}`, { parentName: c.parentName, chunkName: c.name || "?" });
        }
      }
    } catch { /* skip */ }
  }
  return lookup;
}

function getParent(r: ChunkResult, lookup: ParentLookup): string | null {
  if (r.entityName?.includes(".")) return r.entityName.split(".")[0];
  if (r.startLine != null) return lookup.get(`${r.path}:${r.startLine}`)?.parentName ?? null;
  return null;
}

// ── Simulation ──

interface SimResult {
  query: string;
  kind: "broad" | "specific";
  before: ChunkResult[];
  after: ChunkResult[];
  freedSlots: number;
  groupedParents: { name: string; count: number; bestScore: number }[];
  uniqueFilesBefore: number;
  uniqueFilesAfter: number;
}

function simulate(results: ChunkResult[], lookup: ParentLookup, topK: number): SimResult & { before: ChunkResult[]; after: ChunkResult[] } {
  // Detect parent groups
  const groups = new Map<string, { key: string; members: ChunkResult[] }>();
  const nonChildren: ChunkResult[] = [];

  for (const r of results) {
    const parent = getParent(r, lookup);
    if (parent) {
      const key = `${r.path}::${parent}`;
      if (!groups.has(key)) groups.set(key, { key, members: [] });
      groups.get(key)!.members.push(r);
    } else {
      nonChildren.push(r);
    }
  }

  // Apply grouping: ≥2 siblings → keep only the best-scoring one
  const after: ChunkResult[] = [...nonChildren];
  const groupedParents: { name: string; count: number; bestScore: number }[] = [];
  let freedSlots = 0;

  for (const [, g] of groups) {
    if (g.members.length >= 2) {
      // Keep best scoring, drop the rest
      const sorted = g.members.sort((a, b) => b.score - a.score);
      after.push(sorted[0]); // Would be replaced by parent chunk content in real impl
      freedSlots += sorted.length - 1;
      const parentName = getParent(sorted[0], lookup)!;
      groupedParents.push({ name: parentName, count: sorted.length, bestScore: sorted[0].score });
    } else {
      // Only 1 sub-chunk — keep as-is
      after.push(...g.members);
    }
  }

  after.sort((a, b) => b.score - a.score);

  return {
    query: "",
    kind: "broad",
    before: results,
    after: after.slice(0, topK),
    freedSlots,
    groupedParents,
    uniqueFilesBefore: new Set(results.map((r) => r.path)).size,
    uniqueFilesAfter: new Set(after.slice(0, topK).map((r) => r.path)).size,
  };
}

// ── Main ──

async function main() {
  console.log("=== Count-Based Parent Grouping Simulation ===\n");

  for (const project of projects) {
    if (!existsSync(project.dbPath)) {
      console.log(`Skipping ${project.name} — no index at ${project.dbPath}\n`);
      continue;
    }

    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  ${project.name.toUpperCase().padEnd(36)}║`);
    console.log(`╚══════════════════════════════════════╝\n`);

    const config = await loadConfig(project.dir);
    await applyEmbeddingConfig(config);
    const db = new RagDB(project.dbPath);

    process.stdout.write(`Building parent lookup...`);
    const lookup = await buildParentLookup(project.dir);
    console.log(` ${lookup.size} entries\n`);

    const TOP_K = 8;
    let totalBefore = 0;
    let totalAfter = 0;
    let totalFreed = 0;
    let totalGrouped = 0;
    let totalUniqueFilesBefore = 0;
    let totalUniqueFilesAfter = 0;
    let queriesWithGrouping = 0;

    for (const q of project.queries) {
      const results = await searchChunks(q.query, db, TOP_K, 0.3, config.hybridWeight, false);
      const sim = simulate(results, lookup, TOP_K);
      sim.query = q.query;
      sim.kind = q.kind;

      totalBefore += results.length;
      totalAfter += sim.after.length;
      totalFreed += sim.freedSlots;
      totalUniqueFilesBefore += sim.uniqueFilesBefore;
      totalUniqueFilesAfter += sim.uniqueFilesAfter;
      if (sim.freedSlots > 0) {
        queriesWithGrouping++;
        totalGrouped += sim.groupedParents.reduce((s, g) => s + g.count, 0);
      }

      const label = q.kind === "broad" ? "BROAD" : "SPEC ";
      if (sim.freedSlots > 0) {
        console.log(`  [${label}] "${q.query}"`);
        console.log(`         before: ${results.length} results, ${sim.uniqueFilesBefore} unique files`);
        console.log(`         after:  ${sim.after.length} results, ${sim.uniqueFilesAfter} unique files (+${sim.uniqueFilesAfter - sim.uniqueFilesBefore} diversity)`);
        console.log(`         freed:  ${sim.freedSlots} slots`);
        for (const g of sim.groupedParents) {
          console.log(`         ↳ ${g.name}: ${g.count} → 1 (best score: ${g.bestScore.toFixed(3)})`);
        }
      } else {
        console.log(`  [${label}] "${q.query}" — no grouping needed`);
      }
    }

    // Summary
    const pct = (n: number, t: number) => t > 0 ? `${(n / t * 100).toFixed(1)}%` : "0%";

    console.log(`\n  ── Summary for ${project.name} ──`);
    console.log(`  Queries with grouping:  ${queriesWithGrouping}/${project.queries.length}`);
    console.log(`  Total freed slots:      ${totalFreed}`);
    console.log(`  Avg freed per query:    ${(totalFreed / project.queries.length).toFixed(1)}`);
    console.log(`  Sub-chunks grouped:     ${totalGrouped}`);
    console.log(`  Avg unique files:       ${(totalUniqueFilesBefore / project.queries.length).toFixed(1)} → ${(totalUniqueFilesAfter / project.queries.length).toFixed(1)}`);

    db.close();
  }

  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
