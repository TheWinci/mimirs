/**
 * Mega-batching test, measured with the phase profiler.
 *
 * embed-inference is ~95% of cold indexing (see index-profile.ts). The model is
 * currently called once per file (~17 chunks/call, well under the batch of 50).
 * This asks: does grouping chunks ACROSS files into bigger model calls lower the
 * per-chunk cost — WITHOUT touching the thread count (so no extra CPU/heat)?
 *
 * It reads + chunks the real source once, then embeds the exact same chunk set
 * several ways through the real embedBatchMerged (whose model() call is
 * profiled as "embed-inference"). Thread count is left at the default for every
 * arm, so the only variable is batch grouping.
 *
 * Run: bun benchmarks/embed-batch-profile.ts [source-dir]
 */

import { resolve, join } from "path";
import { existsSync } from "fs";
import { parseFile } from "../src/indexing/parse";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { loadConfig } from "../src/config";
import { getEmbedder, embedBatchMerged } from "../src/embeddings/embed";
import { profiler, setProfiling } from "../src/utils/profiler";

const srcDir = resolve(process.argv[2] || ".");

function gitTrackedFiles(dir: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: dir });
  if (proc.exitCode !== 0) return [];
  return proc.stdout.toString().split("\n").filter(Boolean);
}

function chunkBy<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

console.log(`\nMega-batching profile — source: ${srcDir}`);
console.log("=".repeat(70));

// 1. Read + chunk the real source once (no DB, no index lock needed).
const config = await loadConfig(srcDir);
const perFile: string[][] = [];
const allTexts: string[] = [];
for (const rel of gitTrackedFiles(srcDir)) {
  const full = join(srcDir, rel);
  if (!existsSync(full)) continue;
  let raw: string;
  try {
    raw = await Bun.file(full).text();
  } catch {
    continue;
  }
  const parsed = parseFile(full, raw);
  if (!KNOWN_EXTENSIONS.has(parsed.extension)) continue;
  if (!parsed.content.trim()) continue;
  const { chunks } = await chunkText(parsed.content, parsed.extension, config.chunkSize, config.chunkOverlap, full);
  const texts = chunks.map((c) => c.text);
  if (texts.length === 0) continue;
  perFile.push(texts);
  allTexts.push(...texts);
}
console.log(`Prepared ${perFile.length} files, ${allTexts.length} chunks. Threads: default (unchanged).`);

// 2. Load the model (default threads) and warm it up so the first arm doesn't
//    eat ONNX graph-warmup cost.
setProfiling(true);
await getEmbedder();
await embedBatchMerged(allTexts.slice(0, 16));

interface ArmResult {
  label: string;
  wallMs: number;
  inferMs: number;
  calls: number;
  msPerChunk: number;
}

async function arm(label: string, batches: string[][]): Promise<ArmResult> {
  profiler.reset();
  const t0 = performance.now();
  for (const b of batches) {
    await embedBatchMerged(b);
  }
  const wallMs = performance.now() - t0;
  const ei = profiler.snapshot().find((p) => p.label === "embed-inference");
  const inferMs = ei?.ms ?? 0;
  const calls = ei?.calls ?? 0;
  return { label, wallMs, inferMs, calls, msPerChunk: inferMs / allTexts.length };
}

// 3. Arms — same chunks, different grouping into model() calls.
//    Padding waste hypothesis: cost per batch scales with the LONGEST text in
//    it. Sorting by length so each batch is uniform should shrink that waste.
const lengthSorted = [...allTexts].sort((a, b) => b.length - a.length);
const arms: [string, string[][]][] = [
  ["per-file, batch=50 (current)", perFile.flatMap((f) => chunkBy(f, 50))],
  ["length-sorted, batch=50", chunkBy(lengthSorted, 50)],
  ["length-sorted, batch=32", chunkBy(lengthSorted, 32)],
  ["mega-batch=256 (known bad)", chunkBy(allTexts, 256)],
];

const results: ArmResult[] = [];
for (const [label, batches] of arms) {
  process.stdout.write(`Running: ${label} (${batches.length} model calls)... `);
  const r = await arm(label, batches);
  console.log(`${(r.wallMs / 1000).toFixed(1)}s`);
  results.push(r);
}

// 4. Report.
console.log("\n" + "=".repeat(70));
console.log("RESULTS (embed-inference only — thread count identical across arms)");
console.log("=".repeat(70));
const base = results[0].inferMs;
console.log(
  "\n" +
    "arm".padEnd(30) +
    "infer s".padStart(9) +
    "calls".padStart(8) +
    "ms/chunk".padStart(10) +
    "speedup".padStart(9)
);
console.log("-".repeat(66));
for (const r of results) {
  console.log(
    r.label.padEnd(30) +
      (r.inferMs / 1000).toFixed(2).padStart(9) +
      String(r.calls).padStart(8) +
      r.msPerChunk.toFixed(2).padStart(10) +
      (base / r.inferMs).toFixed(2).padStart(8) + "x"
  );
}
console.log("\n" + "=".repeat(70) + "\n");
