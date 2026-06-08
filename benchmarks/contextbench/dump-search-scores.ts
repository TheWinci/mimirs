/**
 * Dump raw file-level search() ranked scores for chosen ContextBench instances to
 * a markdown file — the actual query-result scores, NOT the benchmark cov/prec.
 * For diagnosing the all-miss zeros and the low-score anomalies. Clones+indexes
 * each instance (slow). Run:
 *   bun benchmarks/contextbench/dump-search-scores.ts <tasks.jsonl> <gold.json> <out.md> id1,id2,...
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search } from "../../src/search/hybrid";
import { shallowFetchCheckout } from "../swe-localization/lib";

const INCLUDE = ["**/*.py", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.go", "**/*.rs",
  "**/*.java", "**/*.rb", "**/*.php", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.h", "**/*.hpp", "**/*.cs", "**/*.kt", "**/*.scala"];
const EXCLUDE = ["**/test/**", "**/tests/**", "**/testing/**", "**/__tests__/**",
  "**/*_test.*", "**/*.test.*", "**/test_*.py", "**/conftest.py",
  "node_modules/**", ".git/**", "vendor/**", "third_party/**", "dist/**", "build/**", ".mimirs/**", "**/*.min.js"];

const isBarrel = (b: string) => ["__init__.py", "index.ts", "index.js", "mod.rs"].includes(b);

async function main() {
  const tasksPath = process.argv[2], goldPath = process.argv[3], outPath = process.argv[4];
  const want = new Set((process.argv[5] ?? "").split(",").filter(Boolean));
  const tasks = readFileSync(tasksPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const allGold = JSON.parse(readFileSync(goldPath, "utf8")) as Record<string, { gold: { file: string }[] }>;
  const sel = tasks.filter((t) => want.size === 0 || want.has(t.instance_id));

  writeFileSync(outPath, `# Raw search() scores — ContextBench diagnostic instances\n\nFile-level \`search()\` ranked results (top 40), tags: **G**=gold file, **b**=barrel/index. weight 0.5, tests excluded at index time.\n`);

  for (const t of sel) {
    const goldFiles = new Set((allGold[t.instance_id]?.gold ?? []).map((g) => g.file));
    const sid = t.instance_id.split("__").pop()!.slice(0, 8);
    process.stdout.write(`  ${sid} (${t.repo}@${t.base_commit.slice(0, 8)}) `);
    const dir = resolve(tmpdir(), `cb-dump-${t.instance_id}`);
    rmSync(dir, { recursive: true, force: true });
    if (!shallowFetchCheckout(t.repo, t.base_commit, dir)) { console.log("clone failed"); continue; }
    try {
      mkdirSync(resolve(dir, ".mimirs"), { recursive: true });
      writeFileSync(resolve(dir, ".mimirs/config.json"), JSON.stringify({ include: INCLUDE, exclude: EXCLUDE }, null, 2));
      const db = new RagDB(dir);
      const config = await loadConfig(dir);
      try {
        await indexDirectory(dir, db, config, () => {});
        const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
        // Match cb-adapter exactly (topK=60, generated=[]) so these scores explain
        // the benchmark ranking faithfully — search() ordering is pool-size sensitive.
        const res = await search(t.problem_statement, db, 60, 0, config.hybridWeight, []);
        const goldRanks = res.map((r, i) => goldFiles.has(rel(r.path)) ? i + 1 : 0).filter(Boolean);

        let md = `\n## ${t.repo} — ${sid}  (gold ${goldFiles.size} files)\n\n`;
        md += `gold files: ${[...goldFiles].map((f) => "`" + f + "`").join(", ")}\n\n`;
        md += `gold at ranks: ${goldRanks.length ? goldRanks.join(", ") : "**none in top 40**"}\n\n`;
        md += `| rank | score | Δ% | tag | file |\n|---|---|---|---|---|\n`;
        res.slice(0, 40).forEach((r, i) => {
          const f = rel(r.path);
          const tag = goldFiles.has(f) ? "**G**" : isBarrel(f.split("/").pop() ?? "") ? "b" : "";
          const dp = i > 0 && res[i - 1].score > 0 ? ((res[i - 1].score - r.score) / res[i - 1].score * 100) : 0;
          md += `| ${i + 1} | ${r.score.toFixed(3)} | ${dp.toFixed(0)}% | ${tag} | ${f} |\n`;
        });
        appendFileSync(outPath, md);
        console.log(`gold ranks: ${goldRanks.join(",") || "MISS"}`);
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(`\nWrote ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
