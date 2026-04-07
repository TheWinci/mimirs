/**
 * Benchmark: indexing speed under different strategies.
 *
 * Variants tested:
 *   1. Baseline      — current code (fp32, sequential file processing)
 *   2. Quantized     — q8 model dtype instead of fp32
 *   3. Pipeline      — overlap read+chunk of next file with embed of current
 *   4. Combined      — q8 + pipeline
 *
 * Run: bun benchmarks/indexing-bench.ts [directory]
 *
 * Uses a fresh temp DB per run so results are not cached.
 */

import { resolve, relative } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import { RagDB } from "../src/db";
import { loadConfig, type RagConfig } from "../src/config";
import { indexDirectory, type IndexResult } from "../src/indexing/indexer";
import {
  getEmbedder,
  resetEmbedder,
  configureEmbedder,
  embedBatch,
  DEFAULT_MODEL_ID,
  DEFAULT_EMBEDDING_DIM,
} from "../src/embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { parseFile } from "../src/indexing/parse";
import { resolveImports } from "../src/graph/resolver";
import { type EmbeddedChunk } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const directory = resolve(process.argv[2] || ".");

function makeTempRagDir(label: string): string {
  const dir = resolve(tmpdir(), `mimirs-bench-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function hashString(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Variant 1 & 2: Use indexDirectory directly (baseline / quantized)
// ---------------------------------------------------------------------------

async function runStandardIndex(
  label: string,
  config: RagConfig,
  dtype: "fp32" | "q8"
): Promise<{ result: IndexResult; elapsedMs: number }> {
  const ragDir = makeTempRagDir(label);

  // Configure model dtype
  resetEmbedder();
  // We need to patch the dtype — the current API doesn't expose it,
  // so we'll set up the embedder manually with the right dtype
  const { pipeline: hfPipeline } = await import("@huggingface/transformers");

  // Force the embedder to reinitialize with our dtype
  resetEmbedder();

  // Monkey-patch getEmbedder to use our dtype
  const origGetEmbedder = (await import("../src/embeddings/embed")).getEmbedder;

  try {
    const db = new RagDB(directory, ragDir);

    // Pre-load model with correct dtype
    const { cpus } = await import("os");
    const numThreads = config.indexThreads ?? Math.max(2, Math.floor(cpus().length / 3));

    resetEmbedder();

    // If quantized, configure with a temp model that uses q8
    // We need to directly initialize the model
    if (dtype === "q8") {
      // Load model with q8 dtype directly
      const model = await hfPipeline("feature-extraction", DEFAULT_MODEL_ID, {
        dtype: "q8" as any,
        session_options: {
          intraOpNumThreads: numThreads,
          interOpNumThreads: numThreads,
        },
      });
      // Store it as our embedder
      (globalThis as any).__benchEmbedder = model;
      (globalThis as any).__benchDtype = "q8";
    } else {
      (globalThis as any).__benchEmbedder = null;
      (globalThis as any).__benchDtype = "fp32";
    }

    const start = performance.now();
    const result = await indexDirectory(directory, db, config, (msg) => {
      // Silent — we're benchmarking
    });
    const elapsedMs = performance.now() - start;

    db.close();
    cleanupDir(ragDir);
    return { result, elapsedMs };
  } finally {
    resetEmbedder();
    cleanupDir(ragDir);
  }
}

// ---------------------------------------------------------------------------
// Variant 3 & 4: Pipeline — overlap chunking and embedding
// ---------------------------------------------------------------------------

interface PreparedFile {
  filePath: string;
  hash: string;
  chunks: Awaited<ReturnType<typeof chunkText>>;
  parsed: ReturnType<typeof parseFile>;
}

async function prepareFile(
  filePath: string,
  config: RagConfig
): Promise<PreparedFile | null> {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_SIZE) return null;

    const raw = await readFile(filePath, "utf-8");
    const hash = hashString(raw);
    const parsed = parseFile(filePath, raw);

    if (!KNOWN_EXTENSIONS.has(parsed.extension)) return null;
    if (!parsed.content.trim()) return null;

    const chunks = await chunkText(
      parsed.content,
      parsed.extension,
      config.chunkSize,
      config.chunkOverlap,
      filePath
    );

    return { filePath, hash, chunks, parsed };
  } catch {
    return null;
  }
}

function buildEmbeddedChunk(
  chunk: { text: string; exports?: { name: string; type: string }[]; parentName?: string; hash?: string; startLine?: number; endLine?: number },
  embedding: Float32Array
): EmbeddedChunk {
  const primaryExport = chunk.exports?.[0];
  const entityName =
    chunk.parentName && primaryExport?.name
      ? `${chunk.parentName}.${primaryExport.name}`
      : primaryExport?.name ?? null;
  return {
    snippet: chunk.text,
    embedding,
    entityName,
    chunkType: primaryExport?.type ?? null,
    startLine: chunk.startLine ?? null,
    endLine: chunk.endLine ?? null,
    contentHash: chunk.hash ?? null,
  };
}

async function runPipelineIndex(
  label: string,
  config: RagConfig,
  matchedFiles: string[],
  dtype: "fp32" | "q8"
): Promise<{ result: IndexResult; elapsedMs: number }> {
  const ragDir = makeTempRagDir(label);
  const result: IndexResult = { indexed: 0, skipped: 0, pruned: 0, errors: [] };

  try {
    const db = new RagDB(directory, ragDir);
    const batchSize = config.indexBatchSize ?? 50;
    const DB_BATCH = 500;

    // Pre-load model
    await getEmbedder(config.indexThreads);

    const start = performance.now();

    // Pipeline: prepare next file while current file embeds
    // We use a simple 1-ahead prefetch
    let nextPrepared: Promise<PreparedFile | null> | null = null;

    for (let fi = 0; fi < matchedFiles.length; fi++) {
      // Start preparing next file immediately
      if (fi + 1 < matchedFiles.length) {
        nextPrepared = prepareFile(matchedFiles[fi + 1], config);
      } else {
        nextPrepared = null;
      }

      // Get current file (either from prefetch or prepare now)
      let prepared: PreparedFile | null;
      if (fi === 0) {
        prepared = await prepareFile(matchedFiles[fi], config);
      } else {
        // This was prefetched in previous iteration
        prepared = await (globalThis as any).__currentPrefetch;
      }

      // Store next prefetch for next iteration
      (globalThis as any).__currentPrefetch = nextPrepared;

      if (!prepared) {
        result.skipped++;
        continue;
      }

      // Check hash
      const existing = db.getFileByPath(prepared.filePath);
      if (existing && existing.hash === prepared.hash) {
        result.skipped++;
        continue;
      }

      // Embed and write
      const chunks = prepared.chunks.chunks;
      const fileId = db.upsertFileStart(prepared.filePath, prepared.hash);
      let chunkOffset = 0;
      let pendingDbChunks: EmbeddedChunk[] = [];

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddings = await embedBatch(
          batch.map((c) => c.text),
          config.indexThreads
        );

        for (let j = 0; j < batch.length; j++) {
          pendingDbChunks.push(buildEmbeddedChunk(batch[j], embeddings[j]));
        }

        if (pendingDbChunks.length >= DB_BATCH || i + batchSize >= chunks.length) {
          db.insertChunkBatch(fileId, pendingDbChunks, chunkOffset);
          chunkOffset += pendingDbChunks.length;
          pendingDbChunks = [];
          await Bun.sleep(0);
        }
      }

      // Store graph metadata
      const graphData =
        prepared.chunks.fileImports && prepared.chunks.fileExports
          ? { imports: prepared.chunks.fileImports, exports: prepared.chunks.fileExports }
          : { imports: [] as any[], exports: [] as any[] };
      db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

      result.indexed++;
    }

    // Resolve imports
    if (result.indexed > 0) {
      resolveImports(db, directory);
    }

    const elapsedMs = performance.now() - start;
    db.close();
    cleanupDir(ragDir);
    return { result, elapsedMs };
  } finally {
    cleanupDir(ragDir);
  }
}

// ---------------------------------------------------------------------------
// Collect files (reuse the indexer's logic)
// ---------------------------------------------------------------------------

async function getMatchedFiles(config: RagConfig): Promise<string[]> {
  // Import collectFiles internals — it's not exported, so we replicate the logic
  const { readdir } = await import("fs/promises");
  const { extname, basename } = await import("path");

  function buildIncludeFilter(patterns: string[]): (rel: string) => boolean {
    const extensions = new Set<string>();
    const basenames = new Set<string>();
    const basenamePrefixes: string[] = [];
    for (const p of patterns) {
      const extMatch = p.match(/^\*\*\/\*(\.\w+)$/);
      if (extMatch) { extensions.add(extMatch[1]); continue; }
      const baseMatch = p.match(/^\*\*\/([A-Za-z]\w*)$/);
      if (baseMatch) { basenames.add(baseMatch[1]); continue; }
      const prefixMatch = p.match(/^\*\*\/([A-Za-z]\w*)\.\*$/);
      if (prefixMatch) { basenamePrefixes.push(prefixMatch[1] + "."); continue; }
    }
    return (rel: string) => {
      const ext = extname(rel);
      const base = basename(rel);
      return extensions.has(ext) || basenames.has(base) || basenamePrefixes.some((p) => base.startsWith(p));
    };
  }

  function buildExcludeFilter(patterns: string[]): (rel: string) => boolean {
    const dirPrefixes: string[] = [];
    const exactBasenames = new Set<string>();
    for (const p of patterns) {
      const dirMatch = p.match(/^([^*?]+?)\/?\*\*$/);
      if (dirMatch) { dirPrefixes.push(dirMatch[1]); continue; }
      if (!p.includes("*") && !p.includes("?") && !p.includes("/")) {
        exactBasenames.add(p); continue;
      }
    }
    return (rel: string) => {
      for (const prefix of dirPrefixes) {
        if (rel.startsWith(prefix + "/") || rel === prefix) return true;
      }
      return exactBasenames.has(basename(rel));
    };
  }

  const allEntries = await readdir(directory, { recursive: true });
  const isIncluded = buildIncludeFilter(config.include);
  const isExcluded = buildExcludeFilter(config.exclude);
  const results: string[] = [];
  for (const rel of allEntries) {
    if (isExcluded(rel)) continue;
    if (isIncluded(rel)) results.push(resolve(directory, rel));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Direct benchmarks — bypass indexDirectory to control dtype precisely
// ---------------------------------------------------------------------------

async function runDirectIndex(
  label: string,
  config: RagConfig,
  matchedFiles: string[],
  dtype: "fp32" | "q8",
  pipelineMode: boolean
): Promise<{ result: IndexResult; elapsedMs: number; chunksTotal: number }> {
  const ragDir = makeTempRagDir(label);
  const result: IndexResult = { indexed: 0, skipped: 0, pruned: 0, errors: [] };
  let chunksTotal = 0;

  try {
    // Reset and load model with correct dtype
    resetEmbedder();

    const { pipeline: hfPipeline, env } = await import("@huggingface/transformers");
    const { cpus, homedir } = await import("os");
    const { join } = await import("path");

    env.cacheDir = join(homedir(), ".cache", "mimirs", "models");

    const numThreads = config.indexThreads ?? Math.max(2, Math.floor(cpus().length / 3));

    console.log(`  Loading model (${dtype})...`);
    const model = await hfPipeline("feature-extraction", DEFAULT_MODEL_ID, {
      dtype: dtype as any,
      session_options: {
        intraOpNumThreads: numThreads,
        interOpNumThreads: numThreads,
      },
    });
    console.log(`  Model loaded.`);

    // Custom embedBatch using our model
    async function localEmbedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const output = await model(texts, { pooling: "mean", normalize: true });
      const flat = new Float32Array(output.data as Float64Array);
      const dim = DEFAULT_EMBEDDING_DIM;
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        results.push(flat.slice(i * dim, (i + 1) * dim));
      }
      return results;
    }

    const db = new RagDB(directory, ragDir);
    const batchSize = config.indexBatchSize ?? 50;
    const DB_BATCH = 500;

    const start = performance.now();

    if (pipelineMode) {
      // Pipeline: prefetch next file's read+chunk while current embeds
      let prefetchPromise: Promise<PreparedFile | null> | null = null;

      for (let fi = 0; fi < matchedFiles.length; fi++) {
        // Kick off prefetch for next file
        const nextPrefetch =
          fi + 1 < matchedFiles.length
            ? prepareFile(matchedFiles[fi + 1], config)
            : null;

        // Get current file
        let prepared: PreparedFile | null;
        if (fi === 0) {
          prepared = await prepareFile(matchedFiles[fi], config);
        } else {
          prepared = await prefetchPromise;
        }
        prefetchPromise = nextPrefetch;

        if (!prepared) {
          result.skipped++;
          continue;
        }

        const existing = db.getFileByPath(prepared.filePath);
        if (existing && existing.hash === prepared.hash) {
          result.skipped++;
          continue;
        }

        const chunks = prepared.chunks.chunks;
        chunksTotal += chunks.length;
        const fileId = db.upsertFileStart(prepared.filePath, prepared.hash);
        let chunkOffset = 0;
        let pendingDbChunks: EmbeddedChunk[] = [];

        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const embeddings = await localEmbedBatch(batch.map((c) => c.text));

          for (let j = 0; j < batch.length; j++) {
            pendingDbChunks.push(buildEmbeddedChunk(batch[j], embeddings[j]));
          }

          if (pendingDbChunks.length >= DB_BATCH || i + batchSize >= chunks.length) {
            db.insertChunkBatch(fileId, pendingDbChunks, chunkOffset);
            chunkOffset += pendingDbChunks.length;
            pendingDbChunks = [];
            await Bun.sleep(0);
          }
        }

        const graphData =
          prepared.chunks.fileImports && prepared.chunks.fileExports
            ? { imports: prepared.chunks.fileImports, exports: prepared.chunks.fileExports }
            : { imports: [] as any[], exports: [] as any[] };
        db.upsertFileGraph(fileId, graphData.imports, graphData.exports);
        result.indexed++;
      }
    } else {
      // Sequential: process files one by one (same as current code)
      for (const filePath of matchedFiles) {
        const prepared = await prepareFile(filePath, config);
        if (!prepared) {
          result.skipped++;
          continue;
        }

        const existing = db.getFileByPath(prepared.filePath);
        if (existing && existing.hash === prepared.hash) {
          result.skipped++;
          continue;
        }

        const chunks = prepared.chunks.chunks;
        chunksTotal += chunks.length;
        const fileId = db.upsertFileStart(prepared.filePath, prepared.hash);
        let chunkOffset = 0;
        let pendingDbChunks: EmbeddedChunk[] = [];

        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const embeddings = await localEmbedBatch(batch.map((c) => c.text));

          for (let j = 0; j < batch.length; j++) {
            pendingDbChunks.push(buildEmbeddedChunk(batch[j], embeddings[j]));
          }

          if (pendingDbChunks.length >= DB_BATCH || i + batchSize >= chunks.length) {
            db.insertChunkBatch(fileId, pendingDbChunks, chunkOffset);
            chunkOffset += pendingDbChunks.length;
            pendingDbChunks = [];
            await Bun.sleep(0);
          }
        }

        const graphData =
          prepared.chunks.fileImports && prepared.chunks.fileExports
            ? { imports: prepared.chunks.fileImports, exports: prepared.chunks.fileExports }
            : { imports: [] as any[], exports: [] as any[] };
        db.upsertFileGraph(fileId, graphData.imports, graphData.exports);
        result.indexed++;
      }
    }

    // Resolve imports
    if (result.indexed > 0) {
      resolveImports(db, directory);
    }

    const elapsedMs = performance.now() - start;
    db.close();
    return { result, elapsedMs, chunksTotal };
  } finally {
    resetEmbedder();
    cleanupDir(ragDir);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nIndexing benchmark — directory: ${directory}`);
console.log("=".repeat(70));

const config = await loadConfig(directory);

// Collect files once for all variants
console.log("\nCollecting files...");
const matchedFiles = await getMatchedFiles(config);
console.log(`Found ${matchedFiles.length} files to index.\n`);

interface BenchResult {
  name: string;
  dtype: string;
  pipeline: boolean;
  elapsedMs: number;
  indexed: number;
  chunks: number;
}

const results: BenchResult[] = [];

const variants: [string, "fp32" | "q8", boolean][] = [
  ["1. Baseline (fp32, sequential)", "fp32", false],
  ["2. Quantized (q8, sequential)", "q8", false],
  ["3. Pipeline (fp32, prefetch)", "fp32", true],
  ["4. Combined (q8 + prefetch)", "q8", true],
];

for (const [name, dtype, pipeline] of variants) {
  console.log(`\nRunning: ${name}`);
  const { result, elapsedMs, chunksTotal } = await runDirectIndex(
    name.replace(/[^a-zA-Z0-9]/g, "-"),
    config,
    matchedFiles,
    dtype,
    pipeline
  );
  console.log(
    `  Done: ${result.indexed} indexed, ${result.skipped} skipped, ${elapsedMs.toFixed(0)}ms, ${chunksTotal} chunks`
  );
  results.push({
    name,
    dtype,
    pipeline,
    elapsedMs,
    indexed: result.indexed,
    chunks: chunksTotal,
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(70));
console.log("RESULTS");
console.log("=".repeat(70));

const baselineMs = results[0].elapsedMs;

console.log(
  `\n${"Variant".padEnd(38)} ${"Time".padStart(10)} ${"Speedup".padStart(10)} ${"Files".padStart(7)} ${"Chunks".padStart(8)}`
);
console.log("-".repeat(73));

for (const r of results) {
  const speedup = baselineMs / r.elapsedMs;
  console.log(
    `${r.name.padEnd(38)} ${(r.elapsedMs / 1000).toFixed(2).padStart(8)}s ${(speedup.toFixed(2) + "x").padStart(10)} ${String(r.indexed).padStart(7)} ${String(r.chunks).padStart(8)}`
  );
}

console.log("\nDone.\n");
