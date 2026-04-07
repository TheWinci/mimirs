/**
 * Benchmark v2: test batch size impact and mega-batching across files.
 *
 * Findings from v1: q8 = 1.8x speedup, pipeline prefetch = negligible.
 * Hypothesis: larger embedding batches improve ONNX throughput since
 * avg file produces only ~11 chunks (well under batch size of 50).
 *
 * Variants:
 *   1. q8, per-file batch=50 (current best from v1)
 *   2. q8, per-file batch=200
 *   3. q8, mega-batch: collect all chunks, embed in batches of 200
 *   4. q8, mega-batch: collect all chunks, embed in batches of 500
 *
 * Run: bun benchmarks/indexing-bench-v2.ts [directory]
 */

import { resolve, relative, extname, basename } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { readFile, readdir, stat } from "fs/promises";
import { createHash } from "crypto";
import { RagDB } from "../src/db";
import { loadConfig, type RagConfig } from "../src/config";
import {
  resetEmbedder,
  DEFAULT_MODEL_ID,
  DEFAULT_EMBEDDING_DIM,
} from "../src/embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { parseFile } from "../src/indexing/parse";
import { resolveImports } from "../src/graph/resolver";
import { type EmbeddedChunk } from "../src/types";

const directory = resolve(process.argv[2] || ".");

function makeTempRagDir(label: string): string {
  const dir = resolve(tmpdir(), `mimirs-bench2-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function hashString(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function buildEmbeddedChunk(
  chunk: any,
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

// Collect files
async function getMatchedFiles(config: RagConfig): Promise<string[]> {
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

// Prepare all files: read + chunk
interface PreparedFile {
  filePath: string;
  hash: string;
  chunks: any[];
  fileImports?: any[];
  fileExports?: any[];
}

async function prepareAllFiles(
  matchedFiles: string[],
  config: RagConfig
): Promise<PreparedFile[]> {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const prepared: PreparedFile[] = [];

  for (const filePath of matchedFiles) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) continue;

      const raw = await readFile(filePath, "utf-8");
      const hash = hashString(raw);
      const parsed = parseFile(filePath, raw);
      if (!KNOWN_EXTENSIONS.has(parsed.extension)) continue;
      if (!parsed.content.trim()) continue;

      const result = await chunkText(
        parsed.content,
        parsed.extension,
        config.chunkSize,
        config.chunkOverlap,
        filePath
      );

      prepared.push({
        filePath,
        hash,
        chunks: result.chunks,
        fileImports: result.fileImports,
        fileExports: result.fileExports,
      });
    } catch {}
  }

  return prepared;
}

// Create model with specific dtype
async function createModel(dtype: "fp32" | "q8") {
  const { pipeline: hfPipeline, env } = await import("@huggingface/transformers");
  const { cpus, homedir } = await import("os");
  const { join } = await import("path");

  env.cacheDir = join(homedir(), ".cache", "mimirs", "models");
  const numThreads = Math.max(2, Math.floor(cpus().length / 3));

  return hfPipeline("feature-extraction", DEFAULT_MODEL_ID, {
    dtype: dtype as any,
    session_options: {
      intraOpNumThreads: numThreads,
      interOpNumThreads: numThreads,
    },
  });
}

function makeLocalEmbedBatch(model: any) {
  return async function localEmbedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const output = await model(texts, { pooling: "mean", normalize: true });
    const flat = new Float32Array(output.data as Float64Array);
    const dim = DEFAULT_EMBEDDING_DIM;
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(flat.slice(i * dim, (i + 1) * dim));
    }
    return results;
  };
}

// ---------------------------------------------------------------------------
// Variant A: per-file embedding (current approach, variable batch size)
// ---------------------------------------------------------------------------
async function runPerFile(
  label: string,
  preparedFiles: PreparedFile[],
  embedBatch: (texts: string[]) => Promise<Float32Array[]>,
  batchSize: number
): Promise<{ elapsedMs: number; indexed: number; chunks: number }> {
  const ragDir = makeTempRagDir(label);
  let indexed = 0, totalChunks = 0;

  try {
    const db = new RagDB(directory, ragDir);
    const DB_BATCH = 500;

    const start = performance.now();

    for (const file of preparedFiles) {
      const chunks = file.chunks;
      totalChunks += chunks.length;
      const fileId = db.upsertFileStart(file.filePath, file.hash);
      let chunkOffset = 0;
      let pendingDbChunks: EmbeddedChunk[] = [];

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddings = await embedBatch(batch.map((c: any) => c.text));

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

      db.upsertFileGraph(
        fileId,
        file.fileImports ?? [],
        file.fileExports ?? []
      );
      indexed++;
    }

    if (indexed > 0) resolveImports(db, directory);

    const elapsedMs = performance.now() - start;
    db.close();
    return { elapsedMs, indexed, chunks: totalChunks };
  } finally {
    cleanupDir(ragDir);
  }
}

// ---------------------------------------------------------------------------
// Variant B: mega-batch — collect all chunks across files, embed in big batches
// ---------------------------------------------------------------------------
async function runMegaBatch(
  label: string,
  preparedFiles: PreparedFile[],
  embedBatch: (texts: string[]) => Promise<Float32Array[]>,
  batchSize: number
): Promise<{ elapsedMs: number; indexed: number; chunks: number }> {
  const ragDir = makeTempRagDir(label);
  let totalChunks = 0;

  try {
    const db = new RagDB(directory, ragDir);

    const start = performance.now();

    // Phase 1: collect all chunks with file ownership
    interface ChunkEntry {
      fileIdx: number;
      chunkIdx: number;
      chunk: any;
    }
    const allChunks: ChunkEntry[] = [];
    const fileIds: number[] = [];

    for (let fi = 0; fi < preparedFiles.length; fi++) {
      const file = preparedFiles[fi];
      const fileId = db.upsertFileStart(file.filePath, file.hash);
      fileIds.push(fileId);
      for (let ci = 0; ci < file.chunks.length; ci++) {
        allChunks.push({ fileIdx: fi, chunkIdx: ci, chunk: file.chunks[ci] });
      }
    }

    totalChunks = allChunks.length;

    // Phase 2: embed all chunks in large batches
    const allEmbeddings: Float32Array[] = new Array(allChunks.length);

    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);
      const embeddings = await embedBatch(batch.map((e) => e.chunk.text));
      for (let j = 0; j < batch.length; j++) {
        allEmbeddings[i + j] = embeddings[j];
      }
      await Bun.sleep(0);
    }

    // Phase 3: write to DB grouped by file
    for (let fi = 0; fi < preparedFiles.length; fi++) {
      const file = preparedFiles[fi];
      const fileId = fileIds[fi];
      const fileChunks: EmbeddedChunk[] = [];

      for (let gi = 0; gi < allChunks.length; gi++) {
        if (allChunks[gi].fileIdx === fi) {
          fileChunks.push(
            buildEmbeddedChunk(allChunks[gi].chunk, allEmbeddings[gi])
          );
        }
      }

      db.insertChunkBatch(fileId, fileChunks, 0);
      db.upsertFileGraph(
        fileId,
        file.fileImports ?? [],
        file.fileExports ?? []
      );
    }

    if (preparedFiles.length > 0) resolveImports(db, directory);

    const elapsedMs = performance.now() - start;
    db.close();
    return { elapsedMs, indexed: preparedFiles.length, chunks: totalChunks };
  } finally {
    cleanupDir(ragDir);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nIndexing benchmark v2 — directory: ${directory}`);
console.log("=".repeat(70));

const config = await loadConfig(directory);

console.log("\nCollecting and chunking all files...");
const matchedFiles = await getMatchedFiles(config);
const preparedFiles = await prepareAllFiles(matchedFiles, config);
const totalChunks = preparedFiles.reduce((s, f) => s + f.chunks.length, 0);
console.log(`Prepared ${preparedFiles.length} files, ${totalChunks} chunks total.`);

// Chunk size distribution
const chunkCounts = preparedFiles.map((f) => f.chunks.length);
chunkCounts.sort((a, b) => a - b);
console.log(
  `Chunks per file: min=${chunkCounts[0]}, median=${chunkCounts[Math.floor(chunkCounts.length / 2)]}, max=${chunkCounts[chunkCounts.length - 1]}, avg=${(totalChunks / preparedFiles.length).toFixed(1)}`
);

// Load q8 model once
console.log("\nLoading q8 model...");
const model = await createModel("q8");
const localEmbedBatch = makeLocalEmbedBatch(model);
console.log("Model loaded.\n");

interface BenchResult {
  name: string;
  elapsedMs: number;
  indexed: number;
  chunks: number;
}

const results: BenchResult[] = [];

const variants: [string, () => Promise<{ elapsedMs: number; indexed: number; chunks: number }>][] = [
  [
    "1. q8, per-file, batch=50",
    () => runPerFile("q8-pf-50", preparedFiles, localEmbedBatch, 50),
  ],
  [
    "2. q8, per-file, batch=200",
    () => runPerFile("q8-pf-200", preparedFiles, localEmbedBatch, 200),
  ],
  [
    "3. q8, mega-batch=200",
    () => runMegaBatch("q8-mb-200", preparedFiles, localEmbedBatch, 200),
  ],
  [
    "4. q8, mega-batch=500",
    () => runMegaBatch("q8-mb-500", preparedFiles, localEmbedBatch, 500),
  ],
];

for (const [name, fn] of variants) {
  process.stdout.write(`Running: ${name}... `);
  const r = await fn();
  console.log(`${r.elapsedMs.toFixed(0)}ms`);
  results.push({ name, ...r });
}

console.log("\n" + "=".repeat(70));
console.log("RESULTS");
console.log("=".repeat(70));

const baselineMs = results[0].elapsedMs;
console.log(
  `\n${"Variant".padEnd(35)} ${"Time".padStart(10)} ${"Speedup".padStart(10)} ${"Chunks".padStart(8)}`
);
console.log("-".repeat(63));

for (const r of results) {
  const speedup = baselineMs / r.elapsedMs;
  console.log(
    `${r.name.padEnd(35)} ${(r.elapsedMs / 1000).toFixed(2).padStart(8)}s ${(speedup.toFixed(2) + "x").padStart(10)} ${String(r.chunks).padStart(8)}`
  );
}

console.log("\nDone.\n");
