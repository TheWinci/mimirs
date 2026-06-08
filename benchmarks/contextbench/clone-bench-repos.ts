/**
 * Clone every ContextBench task repo at its base_commit into a persistent dir
 * (parent repos/ folder), with the same .mimirs config + full index the benchmark
 * used — but WITHOUT wiping afterward, so the indexed repos are available to
 * inspect/query. Mirrors cb-adapter's clone+config+index exactly.
 *   bun benchmarks/contextbench/clone-bench-repos.ts <tasks.jsonl> <destBaseDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { shallowFetchCheckout } from "../swe-localization/lib";

const INCLUDE = ["**/*.py", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.go", "**/*.rs",
  "**/*.java", "**/*.rb", "**/*.php", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.h", "**/*.hpp", "**/*.cs", "**/*.kt", "**/*.scala"];
const TEST_EXCLUDES = ["**/test/**", "**/tests/**", "**/testing/**", "**/__tests__/**",
  "**/*_test.*", "**/*.test.*", "**/test_*.py", "**/conftest.py"];
const BASE_EXCLUDE = ["node_modules/**", ".git/**", "vendor/**", "third_party/**", "dist/**", "build/**", ".mimirs/**", "**/*.min.js"];
// TESTS=1 keeps test files in the index (bucket-1: some gold context lives in tests).
const EXCLUDE = process.env.TESTS === "1" ? BASE_EXCLUDE : [...TEST_EXCLUDES, ...BASE_EXCLUDE];

async function main() {
  const tasksPath = process.argv[2];
  const destBase = process.argv[3];
  if (!tasksPath || !destBase) { console.error("usage: bun clone-bench-repos.ts <tasks.jsonl> <destBaseDir>"); process.exit(1); }
  mkdirSync(destBase, { recursive: true });
  const tasks = readFileSync(tasksPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  let ok = 0, failed = 0;
  for (const t of tasks) {
    const name = `${t.repo.split("/")[1]}-${t.instance_id.split("__").pop()!.slice(0, 8)}`;
    const dir = resolve(destBase, name);
    process.stdout.write(`  ${name} (${t.repo}@${t.base_commit.slice(0, 8)}) `);
    const haveIndex = existsSync(resolve(dir, ".mimirs/index.db"));
    if (haveIndex && process.env.FORCE !== "1") { console.log("already indexed, skip"); ok++; continue; }
    // already cloned -> shallowFetchCheckout is a no-op re-fetch; safe to reuse.
    if (!shallowFetchCheckout(t.repo, t.base_commit, dir)) { console.log("CLONE FAILED"); failed++; continue; }
    mkdirSync(resolve(dir, ".mimirs"), { recursive: true });
    writeFileSync(resolve(dir, ".mimirs/config.json"), JSON.stringify({ include: INCLUDE, exclude: EXCLUDE }, null, 2));
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    try {
      let n = 0;
      await indexDirectory(dir, db, config, () => { n++; });
      console.log(`indexed`);
      ok++;
    } catch (e) {
      console.log(`INDEX ERROR ${e instanceof Error ? e.message : e}`);
      failed++;
    } finally { db.close(); }
  }
  console.log(`\nDone. ${ok} ready, ${failed} failed -> ${destBase}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
