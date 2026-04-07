/**
 * Worker script for quality benchmark. Called by quality-bench.ts.
 *
 * Usage: bun benchmarks/quality-bench-worker.ts <fp32|q8> <directory> <ragDir>
 *
 * Indexes the directory, runs benchmark queries, prints JSON result to stdout.
 */

import { resolve, relative, extname, basename } from "path";
import { mkdirSync } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { createHash } from "crypto";
import { cpus, homedir } from "os";
import { join } from "path";
import { RagDB } from "../src/db";
import { loadConfig, type RagConfig } from "../src/config";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_EMBEDDING_DIM,
} from "../src/embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { parseFile } from "../src/indexing/parse";
import { resolveImports } from "../src/graph/resolver";
import { search } from "../src/search/hybrid";
import {
  loadBenchmarkQueries,
  type BenchmarkQuery,
} from "../src/search/benchmark";

const dtype = process.argv[2] as "fp32" | "q8";
const directory = resolve(process.argv[3]);
const ragDir = resolve(process.argv[4]);

mkdirSync(ragDir, { recursive: true });

// ---------------------------------------------------------------------------
// Setup model
// ---------------------------------------------------------------------------

const { pipeline: hfPipeline, env } = await import("@huggingface/transformers");
env.cacheDir = join(homedir(), ".cache", "mimirs", "models");

const numThreads = Math.max(2, Math.floor(cpus().length / 3));

console.error(`[${dtype}] Loading model...`);
const model = await hfPipeline("feature-extraction", DEFAULT_MODEL_ID, {
  dtype: dtype as any,
  session_options: {
    intraOpNumThreads: numThreads,
    interOpNumThreads: numThreads,
  },
});
console.error(`[${dtype}] Model loaded.`);

async function localEmbed(text: string): Promise<Float32Array> {
  const output = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float64Array);
}

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

// ---------------------------------------------------------------------------
// Collect files
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const config = await loadConfig(directory);
const db = new RagDB(directory, ragDir);

// Collect files
const allEntries = await readdir(directory, { recursive: true });
const isIncluded = buildIncludeFilter(config.include);
const isExcluded = buildExcludeFilter(config.exclude);
const matchedFiles: string[] = [];
for (const rel of allEntries) {
  if (isExcluded(rel)) continue;
  if (isIncluded(rel)) matchedFiles.push(resolve(directory, rel));
}

console.error(`[${dtype}] Indexing ${matchedFiles.length} files...`);

function hashString(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

const batchSize = config.indexBatchSize ?? 50;
const DB_BATCH = 500;
let indexed = 0;

const indexStart = performance.now();

for (const filePath of matchedFiles) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > 50 * 1024 * 1024) continue;

    const raw = await readFile(filePath, "utf-8");
    const hash = hashString(raw);
    const parsed = parseFile(filePath, raw);
    if (!KNOWN_EXTENSIONS.has(parsed.extension) || !parsed.content.trim()) continue;

    const chunkResult = await chunkText(
      parsed.content, parsed.extension,
      config.chunkSize, config.chunkOverlap, filePath
    );
    const chunks = chunkResult.chunks;

    const fileId = db.upsertFileStart(filePath, hash);
    let chunkOffset = 0;
    let pending: any[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embeddings = await localEmbedBatch(batch.map(c => c.text));

      for (let j = 0; j < batch.length; j++) {
        const primaryExport = batch[j].exports?.[0];
        const entityName = batch[j].parentName && primaryExport?.name
          ? `${batch[j].parentName}.${primaryExport.name}`
          : primaryExport?.name ?? null;
        pending.push({
          snippet: batch[j].text,
          embedding: embeddings[j],
          entityName,
          chunkType: primaryExport?.type ?? null,
          startLine: batch[j].startLine ?? null,
          endLine: batch[j].endLine ?? null,
          contentHash: batch[j].hash ?? null,
        });
      }

      if (pending.length >= DB_BATCH || i + batchSize >= chunks.length) {
        db.insertChunkBatch(fileId, pending, chunkOffset);
        chunkOffset += pending.length;
        pending = [];
        await Bun.sleep(0);
      }
    }

    db.upsertFileGraph(
      fileId,
      chunkResult.fileImports ?? [],
      chunkResult.fileExports ?? []
    );
    indexed++;
  } catch {}
}

if (indexed > 0) resolveImports(db, directory);

const indexTimeMs = performance.now() - indexStart;
console.error(`[${dtype}] Indexed ${indexed} files in ${indexTimeMs.toFixed(0)}ms`);

// ---------------------------------------------------------------------------
// Run benchmark queries — using our model for query embedding
// ---------------------------------------------------------------------------

// The search() function calls embed() from the embed module, which uses fp32
// by default. We need search to use OUR model. Since we can't monkey-patch
// the module, we'll drive the search manually.

const queries = await loadBenchmarkQueries(resolve("benchmarks/mimirs-queries.json"));
const topK = config.benchmarkTopK;

console.error(`[${dtype}] Running ${queries.length} queries...`);

// We need to replicate what search() does but with our embedder.
// search() calls hybrid search which uses vectorSearch (needs embedding) + textSearch.
// Let's read how vectorSearch works to replicate it.

// Actually, the simplest correct approach: monkey-patch the `embed` function
// at the module level. But ES modules are sealed in Bun.
//
// Alternative: use the db's vector search directly with our query embedding.
// The hybrid search combines vector + FTS. Let's just call it directly.

import { mergeHybridScores } from "../src/search/hybrid";

interface QueryResult {
  query: string;
  recall: number;
  reciprocalRank: number;
  hit: boolean;
  topResults: string[];
}

const perQuery: QueryResult[] = [];

for (const q of queries) {
  const queryEmbedding = await localEmbed(q.query);

  // Use same pipeline as real search: vector + FTS + hybrid merge + dedup
  const vecResults = db.search(queryEmbedding, topK * 3);

  let ftsResults: typeof vecResults = [];
  try {
    ftsResults = db.textSearch(q.query, topK * 3);
  } catch {}

  const merged = mergeHybridScores(vecResults, ftsResults, config.hybridWeight);

  // Deduplicate by file path (same as hybrid.ts)
  const byFile = new Map<string, { path: string; score: number }>();
  for (const r of merged) {
    const existing = byFile.get(r.path);
    if (!existing || r.score > existing.score) {
      byFile.set(r.path, { path: r.path, score: r.score });
    }
  }

  const sorted = [...byFile.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const resultPaths = sorted.map(r => r.path);

  // Calculate metrics
  const expectedNormalized = q.expected.map((p: string) =>
    p.startsWith("/") ? p : resolve(directory, p)
  );

  const found = expectedNormalized.filter((e: string) =>
    resultPaths.some((r) => r === e || r.endsWith(e) || e.endsWith(r))
  );
  const recall = found.length / expectedNormalized.length;

  let reciprocalRank = 0;
  for (let i = 0; i < resultPaths.length; i++) {
    const matchesExpected = expectedNormalized.some(
      (e: string) => resultPaths[i] === e || resultPaths[i].endsWith(e) || e.endsWith(resultPaths[i])
    );
    if (matchesExpected) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  perQuery.push({
    query: q.query,
    recall,
    reciprocalRank,
    hit: found.length > 0,
    topResults: resultPaths.map(p => relative(directory, p)),
  });
}

db.close();

// ---------------------------------------------------------------------------
// Output JSON result
// ---------------------------------------------------------------------------

const totalQueries = perQuery.length;
const avgRecall = perQuery.reduce((s, r) => s + r.recall, 0) / totalQueries;
const avgMrr = perQuery.reduce((s, r) => s + r.reciprocalRank, 0) / totalQueries;
const misses = perQuery.filter(r => !r.hit).length;
const zeroMissRate = misses / totalQueries;

const output = {
  dtype,
  indexTimeMs,
  indexed,
  recall: avgRecall,
  mrr: avgMrr,
  zeroMissRate,
  perQuery,
};

// Print JSON to stdout (the parent process reads this)
console.log(JSON.stringify(output));
