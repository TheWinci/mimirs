/**
 * Phase 0 spike: prove the SWE-bench-Live localization loop AND surface whether
 * hybrid beats lexical at localization — across multiple repos and a hybridWeight
 * sweep — BEFORE building the full harness. See plans/swe-bench-live-localization.md.
 *
 * Run: bun benchmarks/swe-localization/spike.ts [repo1,repo2,...] [countPerRepo]
 */
import { resolve } from "path";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { runBenchmark } from "../../src/search/benchmark";
import { fetchAllRows, parseGoldFiles, metricsAtK, shallowFetchCheckout, type SweRow } from "./lib";

const INCLUDE = [
  "**/*.py", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.go", "**/*.rs",
  "**/*.java", "**/*.rb", "**/*.php", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.h",
  "**/*.hpp", "**/*.cs", "**/*.kt", "**/*.scala", "**/*.md",
];
const EXCLUDE = [
  "**/test/**", "**/tests/**", "**/testing/**", "**/__tests__/**",
  "**/*_test.*", "**/*.test.*", "**/test_*.py", "**/conftest.py",
  "node_modules/**", ".git/**", "vendor/**", "third_party/**",
  "dist/**", "build/**", ".mimirs/**", "**/*.min.js",
];

const WEIGHTS = [0.7, 0.5, 0.3, 0.1, 0.0]; // 0.7 = current default; 0.0 = lexical (+ pipeline boosts)

interface InstResult {
  id: string;
  repo: string;
  gold: string[]; // retrievable gold (relative)
  indexed: number;
  ranked: Record<string, string[]>; // weight -> ranked top-20 paths
}

async function main() {
  const repos = (process.argv[2] || "python-babel/babel").split(",").map((s) => s.trim());
  const count = parseInt(process.argv[3] || "5", 10);

  console.log("Fetching SWE-bench-Live `lite` split...");
  const all = await fetchAllRows("lite");
  const byRepo = new Map<string, SweRow[]>();
  for (const r of all) (byRepo.get(r.repo) ?? byRepo.set(r.repo, []).get(r.repo)!).push(r);
  console.log(`  ${all.length} instances / ${byRepo.size} repos.\n`);

  const results: InstResult[] = [];
  let skippedNew = 0, fetchFail = 0;

  for (const repo of repos) {
    const instances = (byRepo.get(repo) ?? []).slice(0, count);
    if (instances.length === 0) { console.log(`(no lite instances for ${repo})`); continue; }
    console.log(`### ${repo}  (${instances.length} instances)`);

    for (const inst of instances) {
      const golds = parseGoldFiles(inst.patch);
      const retrievable = golds.filter((g) => !g.isNew).map((g) => g.path);
      if (retrievable.length === 0) { skippedNew++; console.log(`  ${inst.instance_id}: all-new gold, skip`); continue; }

      const dir = resolve(tmpdir(), `swe-spike-${inst.instance_id}`);
      rmSync(dir, { recursive: true, force: true });
      try {
        process.stdout.write(`  ${inst.instance_id}  ${inst.base_commit.slice(0, 8)} `);
        if (!shallowFetchCheckout(inst.repo, inst.base_commit, dir)) { fetchFail++; console.log("fetch FAILED"); continue; }
        mkdirSync(resolve(dir, ".mimirs"), { recursive: true });
        writeFileSync(resolve(dir, ".mimirs/config.json"), JSON.stringify({ include: INCLUDE, exclude: EXCLUDE }, null, 2));

        const db = new RagDB(dir);
        const config = await loadConfig(dir);
        const t0 = Date.now();
        const idx = await indexDirectory(dir, db, config, () => {});
        process.stdout.write(`idx ${idx.indexed}f/${((Date.now() - t0) / 1000).toFixed(0)}s `);

        const ranked: Record<string, string[]> = {};
        for (const w of WEIGHTS) {
          const r = await runBenchmark([{ query: inst.problem_statement, expected: retrievable }], db, dir, 20, w);
          ranked[w.toString()] = r.results[0].results.map((x) => x.path);
        }
        db.close();
        results.push({ id: inst.instance_id, repo, gold: retrievable, indexed: idx.indexed, ranked });
        const r1 = metricsAtK(ranked["0.7"], retrievable, 10).recall;
        const r0 = metricsAtK(ranked["0"], retrievable, 10).recall;
        console.log(`| R@10 w.7=${(r1 * 100).toFixed(0)}% w0=${(r0 * 100).toFixed(0)}%`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    console.log("");
  }

  if (results.length === 0) { console.log("No instances ran."); process.exit(1); }

  // ---- Aggregate by weight ----
  const aggBy = (rows: InstResult[], w: string) => {
    const m1 = rows.map((r) => metricsAtK(r.ranked[w], r.gold, 1));
    const m5 = rows.map((r) => metricsAtK(r.ranked[w], r.gold, 5));
    const m10 = rows.map((r) => metricsAtK(r.ranked[w], r.gold, 10));
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    return {
      hit1: avg(m1.map((m) => (m.hit ? 1 : 0))),
      hit5: avg(m5.map((m) => (m.hit ? 1 : 0))),
      hit10: avg(m10.map((m) => (m.hit ? 1 : 0))),
      recall10: avg(m10.map((m) => m.recall)),
      mrr: avg(m10.map((m) => m.rr)),
    };
  };
  const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + "%";

  const printTable = (label: string, rows: InstResult[]) => {
    console.log("=".repeat(72));
    console.log(`${label}  (${rows.length} instances)`);
    console.log("=".repeat(72));
    console.log(`weight   Hit@1   Hit@5  Hit@10  Recall@10   MRR`);
    for (const w of WEIGHTS) {
      const a = aggBy(rows, w.toString());
      const tag = w === 0.7 ? " (default)" : w === 0 ? " (lexical)" : "";
      console.log(`  ${w.toFixed(1)}   ${pct(a.hit1)}   ${pct(a.hit5)}   ${pct(a.hit10)}    ${pct(a.recall10)}     ${a.mrr.toFixed(3)}${tag}`);
    }
    console.log("");
  };

  printTable("ALL REPOS", results);
  for (const repo of repos) {
    const rows = results.filter((r) => r.repo === repo);
    if (rows.length) printTable(repo, rows);
  }

  console.log(`Notes: skipped ${skippedNew} all-new-gold instances, ${fetchFail} fetch failures.`);
  console.log(`Indexed file counts: ${[...new Set(results.map((r) => `${r.repo}=${r.indexed}`))].join(", ")}`);

  // Verdict on the default vs the best-on-this-data weight, by MRR.
  const byW = WEIGHTS.map((w) => ({ w, mrr: aggBy(results, w.toString()).mrr }));
  const best = byW.slice().sort((a, b) => b.mrr - a.mrr)[0];
  const def = byW.find((x) => x.w === 0.7)!;
  console.log("\n" + "-".repeat(72));
  console.log(`MRR: default(0.7)=${def.mrr.toFixed(3)}  best=${best.mrr.toFixed(3)} @ weight ${best.w}`);
  if (best.w < 0.7 && best.mrr - def.mrr > 0.03)
    console.log(`-> Localization favors MORE lexical (weight ${best.w}). The marketing claim must be\n   "mimirs (localization-tuned) vs naive grep", NOT "hybrid default beats BM25".`);
  else
    console.log(`-> Default weight is competitive for localization.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
