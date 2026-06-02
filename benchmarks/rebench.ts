/**
 * Re-measure a first-party benchmark on the CURRENT (fixed) search pipeline.
 * Indexes <dir> fresh into a temp DB (so it doesn't touch any live index or hit
 * the project lock — point it at a copy/clone), then runs <queryFile>.
 *
 * Run: bun benchmarks/rebench.ts <dir> <queryFile> [top=10] [weight=0.5]
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
const top = parseInt(process.argv[4] || "10", 10);
const weight = parseFloat(process.argv[5] || "0.5");

const dbDir = join(tmpdir(), `rebench-${dir.split("/").pop()}-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });

const db = new RagDB(dir, dbDir);
const config = await loadConfig(dir);
const t0 = Date.now();
const idx = await indexDirectory(dir, db, config, () => {});
const idxSec = ((Date.now() - t0) / 1000).toFixed(0);
const chunks = ((db as any).db.query("SELECT COUNT(*) n FROM chunks WHERE chunk_index >= 0").get() as any).n;

const queries = await loadBenchmarkQueries(queryFile);
const s = await runBenchmark(queries, db, dir, top, weight);
db.close();
rmSync(dbDir, { recursive: true, force: true });

console.log(`\n${dir.split("/").pop()}  (${idx.indexed} files, ${chunks} chunks, indexed ${idxSec}s, weight ${weight})`);
console.log(`  Recall@${top}: ${(s.recallAtK * 100).toFixed(1)}%   MRR: ${s.mrr.toFixed(3)}   Zero-miss: ${(s.zeroMissRate * 100).toFixed(1)}% (${queries.length} queries)`);
