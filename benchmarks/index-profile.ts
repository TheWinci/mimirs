/**
 * Per-phase indexing profiler.
 *
 * Breaks indexing wall-clock into named phases (scan, read, hash, parse, chunk,
 * classify, embed-inference, merge, db-write-*, resolve-*) so we can see where
 * time actually goes and decide what is worth optimizing — instead of guessing.
 *
 * It profiles the REAL pipeline (`indexDirectory`), not a reimplementation, via
 * the env-gated timers in src/utils/profiler.ts. To dodge the live index lock
 * (a running MCP server holds .mimirs/index.lock for its lifetime), it indexes a
 * temp COPY of the git-tracked source — the same corpus-copy trick the model/
 * embed benchmarks use.
 *
 * Runs two passes:
 *   COLD — fresh DB, every file embeds (this is where embedding should dominate)
 *   WARM — re-index with nothing changed, every file skips (isolates the
 *          scan + read + hash + db-lookup overhead the watcher/server pays often)
 *
 * Run: bun benchmarks/index-profile.ts [source-dir]
 */

import { resolve, join, dirname } from "path";
import { mkdirSync, rmSync, copyFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { RagDB } from "../src/db";
import { loadConfig } from "../src/config";
import { indexDirectory, type IndexResult } from "../src/indexing/indexer";
import { profiler, setProfiling } from "../src/utils/profiler";

const srcDir = resolve(process.argv[2] || ".");

function gitTrackedFiles(dir: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: dir });
  if (proc.exitCode !== 0) return [];
  return proc.stdout.toString().split("\n").filter(Boolean);
}

console.log(`\nIndexing profiler — source: ${srcDir}`);
console.log("=".repeat(70));

// 1. Build a temp copy of the tracked source so the live index lock can't block
//    us and the corpus is reproducible.
const tmpRoot = resolve(tmpdir(), `mimirs-profile-${Date.now()}`);
const corpusDir = join(tmpRoot, "corpus");
const ragDir = join(tmpRoot, "rag");
mkdirSync(corpusDir, { recursive: true });
mkdirSync(ragDir, { recursive: true });

const tracked = gitTrackedFiles(srcDir);
let copied = 0;
for (const rel of tracked) {
  const from = join(srcDir, rel);
  if (!existsSync(from)) continue;
  const to = join(corpusDir, rel);
  mkdirSync(dirname(to), { recursive: true });
  try {
    copyFileSync(from, to);
    copied++;
  } catch {
    /* skip unreadable */
  }
}
console.log(`Copied ${copied} tracked files to a temp corpus.`);

setProfiling(true);
const config = await loadConfig(corpusDir);
const db = new RagDB(corpusDir, ragDir);

async function runPass(label: string): Promise<{ wall: number; res: IndexResult }> {
  profiler.reset();
  const t0 = performance.now();
  const res = await indexDirectory(corpusDir, db, config, undefined, undefined, { prune: true });
  const wall = performance.now() - t0;
  const status = db.getStatus();
  console.log("\n" + profiler.report(label, wall));
  console.log(
    `  files: ${status.totalFiles}  chunks: ${status.totalChunks}  | ` +
      `indexed=${res.indexed} skipped=${res.skipped} pruned=${res.pruned} errors=${res.errors.length}` +
      (res.locked ? "  [LOCKED]" : "")
  );
  return { wall, res };
}

try {
  const cold = await runPass("COLD  (fresh index — everything embeds)");
  const warm = await runPass("WARM  (re-index, nothing changed — everything skips)");

  console.log("\n" + "=".repeat(70));
  console.log(
    `cold wall: ${(cold.wall / 1000).toFixed(2)}s   warm wall: ${(warm.wall / 1000).toFixed(2)}s`
  );
  console.log(
    "Note: COLD 'model-load' is a one-off (model load/download); WARM reuses the cached singleton."
  );
  console.log("=".repeat(70) + "\n");
} finally {
  db.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
