/**
 * ContextBench adapter — produce mimirs retrieval as a ContextBench trajectory.
 *
 * Unlike SweRank (flat function corpus, which strips mimirs' magic), ContextBench
 * scores retrieval over REAL cloned repos at file / definition / line-span
 * granularity — so the full mimirs pipeline (chunker + graph + path/filename
 * boosts) applies. We emit the unified trajectory format ContextBench expects:
 *   {instance_id, traj_data: {pred_files: [...], pred_spans: {file: [{start,end}]}}}
 * which is then scored by `contextbench.evaluate`. See plans/external-benchmarks-survey.md.
 *
 * For each task: shallow-fetch the repo at base_commit, index it fully with mimirs,
 * query the issue with searchChunks (full hybrid + boosts), and turn the top chunks
 * into pred_files + pred_spans (repo-relative paths, 1-based line ranges).
 *
 * Run:
 *   RAG_DB_DIR=/tmp/cb-db \
 *   bun benchmarks/contextbench/cb-adapter.ts <tasks.jsonl> <pred.jsonl> [limit] [topK] [weight]
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { searchChunks, search } from "../../src/search/hybrid";
import { shallowFetchCheckout } from "../swe-localization/lib";

// Broad multi-language include (ContextBench spans 8 languages); skip tests/vendor
// so retrieval isn't diluted by non-source — gold context is source code.
const INCLUDE = [
  "**/*.py", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.go", "**/*.rs",
  "**/*.java", "**/*.rb", "**/*.php", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.h",
  "**/*.hpp", "**/*.cs", "**/*.kt", "**/*.scala",
];
const EXCLUDE = [
  "**/test/**", "**/tests/**", "**/testing/**", "**/__tests__/**",
  "**/*_test.*", "**/*.test.*", "**/test_*.py", "**/conftest.py",
  "node_modules/**", ".git/**", "vendor/**", "third_party/**",
  "dist/**", "build/**", ".mimirs/**", "**/*.min.js",
];

interface Task {
  instance_id: string;
  repo: string; // owner/name
  base_commit: string;
  problem_statement: string;
}

interface PredSpan { start: number; end: number }
interface PredLine {
  instance_id: string;
  traj_data: { pred_files: string[]; pred_spans: Record<string, PredSpan[]> };
}

/** Absolute indexed path -> repo-relative POSIX path (what ContextBench gold uses). */
function toRepoRel(absPath: string, repoDir: string): string {
  const prefix = repoDir.endsWith("/") ? repoDir : repoDir + "/";
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

interface Variants { fixed8: PredLine; fixed12: PredLine; wall: PredLine; pool: { f: string; s: number; b: boolean }[]; id: string }

async function rankTask(task: Task, topK: number, weight: number, parentMinCount: number, maxSpanLines: number): Promise<Variants | null> {
  const dir = resolve(tmpdir(), `cb-repo-${task.instance_id}`);
  rmSync(dir, { recursive: true, force: true });
  if (!shallowFetchCheckout(task.repo, task.base_commit, dir)) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  try {
    mkdirSync(resolve(dir, ".mimirs"), { recursive: true });
    writeFileSync(resolve(dir, ".mimirs/config.json"), JSON.stringify({ include: INCLUDE, exclude: EXCLUDE }, null, 2));

    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    try {
      await indexDirectory(dir, db, config, () => {});

      // parentMinCount high (e.g. 999) disables parent grouping → tight child-chunk
      // spans instead of whole-parent (class/file) spans. Default 2 = whole-parent
      // when ≥2 siblings hit, which tanks line precision on ContextBench.
      const leafOnly = process.env.LEAF === "1";
      const chunks = await searchChunks(task.problem_statement, db, topK, 0.3, weight, [], undefined, parentMinCount, leafOnly, process.env.SYMEXPAND==="1");
      const pred_spans: Record<string, PredSpan[]> = {};
      const pred_files: string[] = [];
      const addSpan = (absPath: string, start: number, end: number) => {
        const rel = toRepoRel(absPath, dir);
        if (!pred_spans[rel]) { pred_spans[rel] = []; pred_files.push(rel); }
        pred_spans[rel].push({ start, end });
      };
      for (const c of chunks) {
        if (c.startLine == null || c.endLine == null) continue;
        if (maxSpanLines > 0 && c.endLine - c.startLine + 1 > maxSpanLines) continue;
        addSpan(c.path, c.startLine, c.endLine);
      }

      // Graph-coverage expansion: helper files the fix needs are often imported by
      // several retrieved files but score too low to retrieve semantically. Add the
      // tightest chunk of files imported by ≥EXPAND_MIN of the top retrieved files.
      const expandMin = parseInt(process.env.EXPAND ?? "0", 10);
      if (expandMin > 0) {
        const have = new Set(pred_files);
        const impCount = new Map<string, number>();
        const topFiles = [...new Set(chunks.map((c) => toRepoRel(c.path, dir)))].slice(0, 10);
        for (const f of topFiles) {
          const file = db.getFileByPath(`${dir}/${f}`); if (!file) continue;
          for (const d of db.getDependsOn(file.id)) {
            const dp = toRepoRel(d.path, dir);
            if (!have.has(dp)) impCount.set(dp, (impCount.get(dp) ?? 0) + 1);
          }
        }
        for (const [f, n] of impCount) {
          if (n < expandMin) continue;
          const ranges = db.getFileChunkRanges(`${dir}/${f}`).filter((r) => r.startLine != null && r.endLine != null);
          if (!ranges.length) continue;
          ranges.sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!));
          addSpan(`${dir}/${f}`, ranges[0].startLine!, ranges[0].endLine!);
        }
      }
      // FILE_SRC=search: take pred_files from the file-level search() (file dedup +
      // symbol expansion + graph boost) instead of from chunk files. ContextBench
      // scores file metrics from pred_files and line/span from pred_spans
      // independently, so this lifts file coverage/precision while keeping spans.
      // MULTI mode: compute the file-level search() pool ONCE and derive three
      // variants (fixed-8, fixed-12, wall-cutoff adaptive) so we don't clone+index
      // the repo three times. Returns one PredLine per variant.
      const pool = await search(task.problem_statement, db, 60, 0, weight, []);
      const isBarrel = (p: string) => ["__init__.py", "index.ts", "index.js", "mod.rs"].includes((p.split("/").pop() ?? ""));
      const Tp = parseFloat(process.env.ADAPT_TP ?? "0.15");
      const Tr = parseFloat(process.env.ADAPT_TR ?? "1.0");
      const nb = pool.filter((r) => !isBarrel(r.path));
      const s = nb.map((r) => r.score);
      let lastWall = 1;
      for (let i = 1; i < s.length; i++) {
        const raw = s[i - 1] - s[i];
        const pct = s[i - 1] > 0 ? raw / s[i - 1] : 0;
        if (pct >= Tp && raw >= Tr) lastWall = i;
      }
      const threshold = s.length ? s[Math.min(lastWall, s.length - 1)] : 0;
      const filesFixed8 = pool.slice(0, 8).map((r) => toRepoRel(r.path, dir));
      const filesFixed12 = pool.slice(0, 12).map((r) => toRepoRel(r.path, dir));
      // Option B (corrected): barrels are excluded from the WALL calc (their
      // affinity-inflated scores must not fake the cutoff) but ride the SAME
      // threshold — kept iff they score above it, not force-added from the tail.
      const filesB = pool.filter((r) => r.score >= threshold).map((r) => toRepoRel(r.path, dir));
      const mk = (files: string[]): PredLine => ({ instance_id: task.instance_id, traj_data: { pred_files: files, pred_spans } });
      // Dump the full ranked pool (score + barrel flag) so any future cutoff
      // variant can be computed offline with no re-clone.
      const poolDump = pool.map((r) => ({ f: toRepoRel(r.path, dir), s: r.score, b: isBarrel(r.path) }));
      return { fixed8: mk(filesFixed8), fixed12: mk(filesFixed12), wall: mk(filesB), pool: poolDump, id: task.instance_id };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const tasksPath = process.argv[2];
  const outPath = process.argv[3];
  const limit = parseInt(process.argv[4] ?? "0", 10) || Infinity;
  const topK = parseInt(process.argv[5] ?? "20", 10);
  const weight = parseFloat(process.argv[6] ?? "0.5");
  // 2 = mimirs default (group siblings into whole-parent span). 999 = never group
  // (tight child spans) — use to test the line-precision lever.
  const parentMinCount = parseInt(process.argv[7] ?? "2", 10);
  const maxSpanLines = parseInt(process.argv[8] ?? "0", 10); // 0 = no cap; e.g. 120 drops parent chunks
  if (!tasksPath || !outPath) {
    console.error("usage: bun cb-adapter.ts <tasks.jsonl> <pred.jsonl> [limit] [topK] [weight] [parentMinCount] [maxSpanLines]");
    process.exit(1);
  }

  const tasks = readFileSync(tasksPath, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Task).slice(0, limit);
  console.log(`Producing trajectories for ${tasks.length} tasks (topK=${topK}, weight=${weight}, parentMinCount=${parentMinCount}, maxSpanLines=${maxSpanLines})...`);

  // Three variants share one clone+index pass; write one pred file per variant.
  // outPath "x.jsonl" -> x.fixed8.jsonl / x.fixed12.jsonl / x.wall.jsonl
  const variantPath = (v: string) => outPath.replace(/\.jsonl$/, `.${v}.jsonl`);
  const vnames = ["fixed8", "fixed12", "wall"] as const;
  for (const v of vnames) writeFileSync(variantPath(v), "");
  const poolPath = outPath.replace(/\.jsonl$/, ".pools.jsonl");
  writeFileSync(poolPath, "");
  let done = 0, ok = 0, failed = 0;
  for (const task of tasks) {
    process.stdout.write(`  ${task.instance_id} (${task.repo}@${task.base_commit.slice(0, 8)}) `);
    let pred: Variants | null = null;
    try {
      pred = await rankTask(task, topK, weight, parentMinCount, maxSpanLines);
    } catch (e) {
      console.log(`ERROR ${e instanceof Error ? e.message : e}`);
    }
    if (pred) {
      for (const v of vnames) appendFileSync(variantPath(v), JSON.stringify(pred[v]) + "\n");
      appendFileSync(poolPath, JSON.stringify({ id: pred.id, pool: pred.pool }) + "\n");
      ok++;
      console.log(`-> f8=${pred.fixed8.traj_data.pred_files.length} f12=${pred.fixed12.traj_data.pred_files.length} B=${pred.wall.traj_data.pred_files.length} files`);
    } else {
      failed++;
      console.log("(skipped: clone/index failed)");
    }
    done++;
    if (done % 5 === 0) console.log(`  [${done}/${tasks.length}] ok=${ok} failed=${failed}`);
  }
  console.log(`Done. ${ok}×3 trajectories -> ${vnames.map(variantPath).join(", ")} (${failed} failed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
