/**
 * Arm A (plans/retrieval-ab-harness.md): contextual chunk preamble before
 * embedding. Re-indexes the repo into a fresh DB (RAG_DB_DIR) and scores the
 * query set with file-level search(). Preamble is gated by RAG_PREAMBLE=1, read
 * at indexer import time — so run this TWICE, once per condition:
 *
 *   RAG_DB_DIR=/tmp/ab-pre-off bun benchmarks/contextbench/preamble-lab.ts . benchmarks/mimirs-queries.json
 *   RAG_PREAMBLE=1 RAG_DB_DIR=/tmp/ab-pre-on bun benchmarks/contextbench/preamble-lab.ts . benchmarks/mimirs-queries.json
 */
import { readFileSync, rmSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search } from "../../src/search/hybrid";

interface Q { query: string; expected: string[] }
const dir = resolve(process.argv[2] ?? process.cwd());
const queriesPath = process.argv[3] ?? "benchmarks/mimirs-queries.json";
const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as Q[];
const K = 10;
const PRE = process.env.RAG_PREAMBLE === "1";

function hit(p: string, e: string) { return p === e || p.endsWith("/" + e) || p.endsWith(e); }

async function main() {
  const dbDir = process.env.RAG_DB_DIR;
  if (!dbDir) { console.error("set RAG_DB_DIR to an empty scratch dir"); process.exit(1); }
  rmSync(dbDir, { recursive: true, force: true });

  const db = new RagDB(dir);
  const cfg = await loadConfig(dir);
  process.stdout.write(`indexing ${dir} -> ${dbDir}  (preamble=${PRE ? "ON" : "off"}) ... `);
  const t0 = performance.now();
  await indexDirectory(dir, db, cfg, () => {});
  const indexMs = performance.now() - t0;
  console.log(`done in ${(indexMs / 1000).toFixed(1)}s`);

  let recall = 0, mrr = 0, zero = 0;
  for (const q of queries) {
    const res = await search(q.query, db, 40, 0, cfg.hybridWeight, cfg.generated);
    const files = res.map((r) => r.path);
    const top = files.slice(0, K);
    const found = q.expected.filter((e) => top.some((f) => hit(f, e)));
    recall += q.expected.length ? found.length / q.expected.length : 0;
    let rank = 0;
    for (let i = 0; i < files.length; i++) if (q.expected.some((e) => hit(files[i], e))) { rank = i + 1; break; }
    mrr += rank ? 1 / rank : 0;
    if (!rank || rank > K) zero++;
  }
  const n = queries.length;
  console.log(`\npreamble=${PRE ? "ON" : "off"}  n=${n}`);
  console.log(`  recall@${K}: ${(recall / n * 100).toFixed(1)}%`);
  console.log(`  MRR:       ${(mrr / n).toFixed(3)}`);
  console.log(`  zero-miss: ${(zero / n * 100).toFixed(1)}%`);
  console.log(`  index:     ${(indexMs / 1000).toFixed(1)}s`);
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
