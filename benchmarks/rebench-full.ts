/**
 * Re-measure a first-party benchmark on the CURRENT pipeline, capturing the full
 * K-sweep (recall@5/7/10/15/20 + zero-miss) and MRR from ONE index, by searching
 * at top-20 and recomputing each K. Indexes <dir> fresh into a temp DB (point at
 * a copy/clone to avoid the project lock).
 *
 * Run: bun benchmarks/rebench-full.ts <dir> <queryFile> [weight=0.5]
 */
import { resolve, join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { RagDB } from "../src/db";
import { loadConfig } from "../src/config";
import { indexDirectory } from "../src/indexing/indexer";
import { loadBenchmarkQueries, runBenchmark } from "../src/search/benchmark";

const dir = resolve(process.argv[2]);
const queryFile = resolve(process.argv[3]);
const weight = parseFloat(process.argv[4] || "0.5");
const Ks = [5, 7, 10, 15, 20];

const dbDir = join(tmpdir(), `rebf-${dir.split("/").pop()}-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
const db = new RagDB(dir, dbDir);
const config = await loadConfig(dir);
const t0 = Date.now();
const idx = await indexDirectory(dir, db, config, () => {});
const sec = ((Date.now() - t0) / 1000).toFixed(0);
const chunks = ((db as any).db.query("SELECT COUNT(*) n FROM chunks WHERE chunk_index >= 0").get() as any).n;

const queries = await loadBenchmarkQueries(queryFile);
const summary = await runBenchmark(queries, db, dir, 20, weight);
db.close();
rmSync(dbDir, { recursive: true, force: true });

const matches = (r: string, e: string) => r === e || r.endsWith(e) || e.endsWith(r);
const norm = (p: string) => (p.startsWith("/") ? p : resolve(dir, p));
const atK = (k: number) => {
  let recall = 0, miss = 0;
  for (const res of summary.results) {
    const ranked = res.results.slice(0, k).map((x) => x.path);
    const exp = res.expected.map(norm);
    const found = exp.filter((e) => ranked.some((r) => matches(r, e)));
    recall += found.length / exp.length;
    if (found.length === 0) miss++;
  }
  return { recall: recall / summary.results.length, miss: miss / summary.results.length };
};
let rr = 0;
for (const res of summary.results) {
  const exp = res.expected.map(norm);
  for (let i = 0; i < res.results.length; i++) {
    if (exp.some((e) => matches(res.results[i].path, e))) { rr += 1 / (i + 1); break; }
  }
}
const mrr = rr / summary.results.length;

console.log(`\n## ${dir.split("/").pop()}  (${idx.indexed} files, ${chunks} chunks, ${sec}s, weight ${weight}, ${queries.length} queries)`);
console.log(`MRR ${mrr.toFixed(3)}`);
for (const k of Ks) {
  const m = atK(k);
  console.log(`  @${String(k).padStart(2)}: recall ${(m.recall * 100).toFixed(1).padStart(5)}%  zero-miss ${(m.miss * 100).toFixed(1)}%`);
}
