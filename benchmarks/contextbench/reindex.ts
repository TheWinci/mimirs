/**
 * Re-index the cached cb-repos in place (after a mimirs chunker/indexer change),
 * each with its own .mimirs/config.json (py-only, tests excluded). Rebuilds
 * <dir>/.mimirs/index.db.
 *
 * Run: bun benchmarks/contextbench/reindex.ts
 */
import { readdirSync, existsSync, statSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";

const CB = "/Users/winci/repos/cb-repos";

async function main() {
  const dirs = readdirSync(CB)
    .filter((d) => existsSync(`${CB}/${d}/.mimirs`) && statSync(`${CB}/${d}`).isDirectory())
    .sort();
  console.log(`re-indexing ${dirs.length} cb-repos...\n`);
  for (const d of dirs) {
    const dir = `${CB}/${d}`;
    const t = performance.now();
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    try {
      const res = await indexDirectory(dir, db, cfg, () => {});
      const files = (db as unknown as { db: { query(s: string): { get(): { n: number } } } }).db.query("SELECT COUNT(*) n FROM files").get().n;
      const chunks = (db as unknown as { db: { query(s: string): { get(): { n: number } } } }).db.query("SELECT COUNT(*) n FROM chunks WHERE chunk_index >= 0").get().n;
      console.log(`  ${d.padEnd(22)} ${files} files, ${chunks} chunks  (${((performance.now() - t) / 1000).toFixed(0)}s)` + (res ? "" : ""));
    } catch (e) {
      console.log(`  ${d.padEnd(22)} ERROR ${e instanceof Error ? e.message : e}`);
    } finally {
      db.close();
    }
  }
  console.log(`\ndone — now: bun benchmarks/contextbench/cb-score.ts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
