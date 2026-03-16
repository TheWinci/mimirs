/**
 * Quality benchmark: compare fp32 vs q8 embedding quality.
 *
 * Spawns two child processes (one per dtype) to get clean model isolation.
 * Each child indexes the project, runs benchmark queries, and prints JSON results.
 *
 * Run: bun benchmarks/quality-bench.ts
 */

import { resolve } from "path";
import { rmSync } from "fs";
import { tmpdir } from "os";

const directory = resolve(".");
const workerScript = resolve("benchmarks/quality-bench-worker.ts");

interface WorkerResult {
  dtype: string;
  indexTimeMs: number;
  indexed: number;
  recall: number;
  mrr: number;
  zeroMissRate: number;
  perQuery: { query: string; recall: number; reciprocalRank: number; hit: boolean; topResults: string[] }[];
}

async function runWorker(dtype: "fp32" | "q8"): Promise<WorkerResult> {
  const ragDir = resolve(tmpdir(), `local-rag-quality-${dtype}-${Date.now()}`);

  const proc = Bun.spawn(["bun", workerScript, dtype, directory, ragDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Cleanup
  try { rmSync(ragDir, { recursive: true, force: true }); } catch {}

  if (exitCode !== 0) {
    console.error(`Worker ${dtype} failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    process.exit(1);
  }

  // Parse JSON result from last line of stdout
  const lines = stdout.trim().split("\n");
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nQuality benchmark: fp32 vs q8`);
console.log(`Directory: ${directory}`);
console.log("=".repeat(70));

console.log("\nRunning fp32...");
const fp32 = await runWorker("fp32");
console.log(`  Done: recall=${(fp32.recall * 100).toFixed(1)}% MRR=${fp32.mrr.toFixed(3)} (${fp32.indexTimeMs.toFixed(0)}ms)`);

console.log("\nRunning q8...");
const q8 = await runWorker("q8");
console.log(`  Done: recall=${(q8.recall * 100).toFixed(1)}% MRR=${q8.mrr.toFixed(3)} (${q8.indexTimeMs.toFixed(0)}ms)`);

// --- Comparison ---
console.log("\n" + "=".repeat(70));
console.log("COMPARISON");
console.log("=".repeat(70));

console.log(
  `\n${"Metric".padEnd(25)} ${"fp32".padStart(10)} ${"q8".padStart(10)} ${"Delta".padStart(10)}`
);
console.log("-".repeat(55));

const metrics: [string, number, number, "pp" | "s"][] = [
  ["Recall@5", fp32.recall, q8.recall, "pp"],
  ["MRR", fp32.mrr, q8.mrr, "pp"],
  ["Zero-miss rate", fp32.zeroMissRate, q8.zeroMissRate, "pp"],
  ["Index time", fp32.indexTimeMs / 1000, q8.indexTimeMs / 1000, "s"],
];

for (const [name, fp32Val, q8Val, unit] of metrics) {
  const delta = q8Val - fp32Val;
  const deltaStr = unit === "s"
    ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)}s`
    : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`;
  const fmt = unit === "s"
    ? (v: number) => v.toFixed(2) + "s"
    : (v: number) => (v * 100).toFixed(1) + "%";
  console.log(
    `${name.padEnd(25)} ${fmt(fp32Val).padStart(10)} ${fmt(q8Val).padStart(10)} ${deltaStr.padStart(10)}`
  );
}

// Per-query differences
console.log("\nPer-query differences:");
let diffs = 0;
for (let i = 0; i < fp32.perQuery.length; i++) {
  const f = fp32.perQuery[i];
  const q = q8.perQuery[i];
  if (f.recall !== q.recall || f.reciprocalRank !== q.reciprocalRank) {
    diffs++;
    console.log(`  "${f.query}"`);
    console.log(`    fp32: recall=${(f.recall * 100).toFixed(0)}% RR=${f.reciprocalRank.toFixed(3)} top=[${f.topResults.slice(0, 3).join(", ")}]`);
    console.log(`    q8:   recall=${(q.recall * 100).toFixed(0)}% RR=${q.reciprocalRank.toFixed(3)} top=[${q.topResults.slice(0, 3).join(", ")}]`);
  }
}
if (diffs === 0) {
  console.log("  None — identical ranking on all queries.");
}

console.log(`\nSpeedup: ${(fp32.indexTimeMs / q8.indexTimeMs).toFixed(2)}x faster with q8`);
console.log("\nDone.\n");
