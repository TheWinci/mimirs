/**
 * Benchmark: impact of skipping sub-chunking for structured formats.
 *
 * Indexes the project twice (into separate DBs):
 *   A) Current behavior — heuristic chunks get sub-chunked at 512 chars
 *   B) No sub-chunking — chunkSize set to 999999 to disable splitting
 *
 * Compares:
 *   - Chunk count & size distribution
 *   - Search quality (Recall@10, MRR, zero-miss)
 */
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve, extname } from "path";
import { RagDB } from "../src/db";
import { loadConfig, applyEmbeddingConfig, type RagConfig } from "../src/config";
import { indexDirectory } from "../src/indexing/indexer";
import { loadBenchmarkQueries, runBenchmark, formatBenchmarkReport } from "../src/search/benchmark";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { parseFile } from "../src/indexing/parse";
import { resolveImports } from "../src/graph/resolver";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const QUERIES_PATH = join(PROJECT_DIR, "benchmarks", "local-rag-queries.json");
const TMP_DIR = join(PROJECT_DIR, ".rag", "bench-subchunk");
const TOP_K = 10;

// ── Helpers ──

function makeDB(name: string): RagDB {
  const dbDir = join(TMP_DIR, name);
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "index.db");
  if (existsSync(dbPath)) rmSync(dbPath);
  return new RagDB(dbPath);
}

interface ChunkStats {
  totalChunks: number;
  totalChars: number;
  avgChunkSize: number;
  medianChunkSize: number;
  maxChunkSize: number;
  minChunkSize: number;
  chunksOver512: number;
  chunksOver1024: number;
  chunksOver2048: number;
}

function computeStats(sizes: number[]): ChunkStats {
  if (sizes.length === 0) {
    return { totalChunks: 0, totalChars: 0, avgChunkSize: 0, medianChunkSize: 0, maxChunkSize: 0, minChunkSize: 0, chunksOver512: 0, chunksOver1024: 0, chunksOver2048: 0 };
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  return {
    totalChunks: sizes.length,
    totalChars: sizes.reduce((s, v) => s + v, 0),
    avgChunkSize: Math.round(sizes.reduce((s, v) => s + v, 0) / sizes.length),
    medianChunkSize: sorted[Math.floor(sorted.length / 2)],
    maxChunkSize: sorted[sorted.length - 1],
    minChunkSize: sorted[0],
    chunksOver512: sizes.filter((s) => s > 512).length,
    chunksOver1024: sizes.filter((s) => s > 1024).length,
    chunksOver2048: sizes.filter((s) => s > 2048).length,
  };
}

function printStats(label: string, stats: ChunkStats) {
  console.log(`\n  ${label}:`);
  console.log(`    Total chunks:     ${stats.totalChunks}`);
  console.log(`    Total chars:      ${stats.totalChars.toLocaleString()}`);
  console.log(`    Avg chunk size:   ${stats.avgChunkSize} chars`);
  console.log(`    Median:           ${stats.medianChunkSize} chars`);
  console.log(`    Min / Max:        ${stats.minChunkSize} / ${stats.maxChunkSize} chars`);
  console.log(`    Chunks > 512:     ${stats.chunksOver512} (${pct(stats.chunksOver512, stats.totalChunks)})`);
  console.log(`    Chunks > 1024:    ${stats.chunksOver1024} (${pct(stats.chunksOver1024, stats.totalChunks)})`);
  console.log(`    Chunks > 2048:    ${stats.chunksOver2048} (${pct(stats.chunksOver2048, stats.totalChunks)})`);
}

function pct(n: number, total: number): string {
  return total > 0 ? `${(n / total * 100).toFixed(1)}%` : "0%";
}

// Collect all indexable files from the project (simplified version)
async function getProjectFiles(config: RagConfig): Promise<{ absPath: string; relPath: string }[]> {
  const files: { absPath: string; relPath: string }[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = abs.slice(PROJECT_DIR.length + 1);

      // Skip hidden dirs, node_modules, .rag
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!KNOWN_EXTENSIONS.has(ext)) continue;
      // Skip test fixtures and benchmarks
      if (rel.startsWith("tests/fixtures/")) continue;

      files.push({ absPath: abs, relPath: rel });
    }
  }

  walk(PROJECT_DIR);
  return files;
}

// ── Chunk analysis (fast, no embedding) ──

async function analyzeChunks(chunkSize: number) {
  const config = await loadConfig(PROJECT_DIR);
  const files = await getProjectFiles(config);
  const sizes: number[] = [];
  const oversizedFiles: { path: string; largest: number; count: number }[] = [];

  for (const file of files) {
    const raw = readFileSync(file.absPath, "utf-8");
    const parsed = parseFile(file.absPath, raw);

    const result = await chunkText(
      parsed.content,
      parsed.extension,
      chunkSize,
      50,
      file.absPath,
    );

    for (const chunk of result.chunks) {
      sizes.push(chunk.text.length);
    }

    const big = result.chunks.filter((c) => c.text.length > 512);
    if (big.length > 0) {
      oversizedFiles.push({
        path: file.relPath,
        largest: Math.max(...big.map((c) => c.text.length)),
        count: big.length,
      });
    }
  }

  return { sizes, oversizedFiles };
}

// ── Main ──

async function main() {
  console.log("=== Sub-chunking Impact Benchmark ===\n");
  console.log(`Project: ${PROJECT_DIR}`);

  const config = await loadConfig(PROJECT_DIR);
  await applyEmbeddingConfig(config);
  const queries = await loadBenchmarkQueries(QUERIES_PATH);
  console.log(`Queries: ${queries.length}`);

  // Clean up
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // ── Phase 1: Chunk size analysis (fast, no embedding) ──
  console.log("\n── Phase 1: Chunk Size Analysis ──");

  console.log("\nAnalyzing with sub-chunking (current, 512 chars)...");
  const withSub = await analyzeChunks(512);
  printStats("WITH sub-chunking (current)", computeStats(withSub.sizes));

  console.log("\nAnalyzing without sub-chunking...");
  const noSub = await analyzeChunks(999999);
  const noSubStats = computeStats(noSub.sizes);
  printStats("WITHOUT sub-chunking", noSubStats);

  const delta = computeStats(withSub.sizes).totalChunks - noSubStats.totalChunks;
  console.log(`\n  Chunk count delta: ${delta > 0 ? "+" : ""}${delta} chunks (${delta > 0 ? "more" : "fewer"} with sub-chunking)`);

  if (noSub.oversizedFiles.length > 0) {
    console.log(`\n  Files with chunks > 512 chars (without sub-chunking):`);
    const sorted = noSub.oversizedFiles.sort((a, b) => b.largest - a.largest);
    for (const f of sorted.slice(0, 25)) {
      console.log(`    ${f.path.padEnd(45)} ${f.count} chunk(s), largest: ${f.largest} chars`);
    }
  }

  // ── Phase 2: Index both variants and benchmark search quality ──
  console.log("\n── Phase 2: Search Quality Comparison ──");

  console.log("\nIndexing A (with sub-chunking)...");
  const dbA = makeDB("with-subchunk");
  await indexDirectory(PROJECT_DIR, dbA, config);
  resolveImports(dbA, PROJECT_DIR);

  console.log("Benchmarking A...");
  const resultA = await runBenchmark(queries, dbA, PROJECT_DIR, TOP_K, config.hybridWeight, config.enableReranking);

  console.log("\nIndexing B (without sub-chunking)...");
  const dbB = makeDB("no-subchunk");
  const configB = { ...config, chunkSize: 999999 };
  await indexDirectory(PROJECT_DIR, dbB, configB);
  resolveImports(dbB, PROJECT_DIR);

  console.log("Benchmarking B...");
  const resultB = await runBenchmark(queries, dbB, PROJECT_DIR, TOP_K, config.hybridWeight, config.enableReranking);

  // ── Results ──
  console.log("\n══════════════════════════════════════");
  console.log("          SEARCH QUALITY");
  console.log("══════════════════════════════════════\n");

  console.log("A) WITH sub-chunking (current):");
  console.log(formatBenchmarkReport(resultA, TOP_K));

  console.log("\nB) WITHOUT sub-chunking:");
  console.log(formatBenchmarkReport(resultB, TOP_K));

  // ── Delta ──
  const dRecall = (resultB.recallAtK - resultA.recallAtK) * 100;
  const dMRR = resultB.mrr - resultA.mrr;
  const dZero = (resultB.zeroMissRate - resultA.zeroMissRate) * 100;

  console.log("\n── Delta (B minus A) ──");
  console.log(`  Recall@${TOP_K}:      ${dRecall >= 0 ? "+" : ""}${dRecall.toFixed(1)}pp`);
  console.log(`  MRR:            ${dMRR >= 0 ? "+" : ""}${dMRR.toFixed(3)}`);
  console.log(`  Zero-miss:      ${dZero >= 0 ? "+" : ""}${dZero.toFixed(1)}pp`);

  // ── Per-query divergence ──
  const divergent = queries.map((q, i) => ({
    query: q.query,
    recallA: resultA.results[i].recall,
    recallB: resultB.results[i].recall,
    rrA: resultA.results[i].reciprocalRank,
    rrB: resultB.results[i].reciprocalRank,
  })).filter((d) => d.recallA !== d.recallB || Math.abs(d.rrA - d.rrB) > 0.01);

  if (divergent.length > 0) {
    console.log("\n── Per-query differences ──");
    for (const d of divergent) {
      const recallDir = d.recallB > d.recallA ? "↑" : d.recallB < d.recallA ? "↓" : "=";
      const rrDir = d.rrB > d.rrA ? "↑" : d.rrB < d.rrA ? "↓" : "=";
      console.log(`  "${d.query}"`);
      console.log(`    Recall: ${(d.recallA * 100).toFixed(0)}% → ${(d.recallB * 100).toFixed(0)}% ${recallDir}   RR: ${d.rrA.toFixed(3)} → ${d.rrB.toFixed(3)} ${rrDir}`);
    }
  } else {
    console.log("\n  No per-query differences — results identical.");
  }

  // Cleanup
  dbA.close();
  dbB.close();
  rmSync(TMP_DIR, { recursive: true });

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
