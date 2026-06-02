/**
 * Embedding-model A/B: for each candidate, capture (1) index/embed time,
 * (2) on-disk index size, (3) retrieval scores (keyword + semantic, weight 0.5).
 *
 * Indexes a COPY of the source (avoids the live indexer lock). The model file is
 * cached globally (~/.cache/mimirs/models) so the first download per model is
 * one-time; we WARM the model before timing so the timer measures embed+index
 * compute, not the download. Run: bun benchmarks/model-ab.ts
 */
import { join } from "path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { RagDB } from "../src/db";
import { loadConfig } from "../src/config";
import { getEmbedder } from "../src/embeddings/embed";
import { indexDirectory } from "../src/indexing/indexer";
import { loadBenchmarkQueries, runBenchmark } from "../src/search/benchmark";

const SRC = "/Users/winci/repos/mimirs";
const CORPUS = join(tmpdir(), "mimirs-modelab-corpus");
const ROOT = join(tmpdir(), "mimirs-modelab");

const ARMS = [
  { label: "all-MiniLM-L6-v2 (384, mean)", id: "Xenova/all-MiniLM-L6-v2", dim: 384, pooling: "mean" },
  { label: "gte-modernbert   (768, cls)", id: "Alibaba-NLP/gte-modernbert-base", dim: 768, pooling: "cls" },
  { label: "gte-modernbert   (768, mean)", id: "Alibaba-NLP/gte-modernbert-base", dim: 768, pooling: "mean" },
  { label: "arctic-embed-m2  (768, cls)", id: "Snowflake/snowflake-arctic-embed-m-v2.0", dim: 768, pooling: "cls" },
];

function setupCorpus() {
  rmSync(CORPUS, { recursive: true, force: true });
  mkdirSync(join(CORPUS, ".mimirs"), { recursive: true });
  for (const d of ["src", "docs"]) Bun.spawnSync(["cp", "-R", join(SRC, d), join(CORPUS, d)]);
  Bun.spawnSync(["bash", "-c", `cp ${SRC}/*.md ${CORPUS}/ 2>/dev/null; cp ${SRC}/.mimirs/config.json ${CORPUS}/.mimirs/config.json`]);
}

function writeArmConfig(arm: typeof ARMS[number]) {
  const path = join(CORPUS, ".mimirs", "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  cfg.embeddingModel = arm.id;
  cfg.embeddingDim = arm.dim;
  cfg.embeddingPooling = arm.pooling;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  setupCorpus();
  const kw = await loadBenchmarkQueries(join(SRC, "benchmarks/mimirs-queries.json"));
  const sem = await loadBenchmarkQueries(join(SRC, "benchmarks/semantic-queries.json"));

  interface Row { label: string; files: number; sec: number; mb: number; kR: number; kM: number; sR: number; sM: number; }
  const rows: Row[] = [];

  for (let i = 0; i < ARMS.length; i++) {
    const arm = ARMS[i];
    const armDir = join(ROOT, `arm${i}`);
    mkdirSync(armDir, { recursive: true });
    writeArmConfig(arm);
    try {
      const db = new RagDB(CORPUS, armDir); // reads corpus config -> configures model/dim/pooling
      await getEmbedder(); // warm (download + load) so it's excluded from the index timer
      const t0 = Date.now();
      const idx = await indexDirectory(CORPUS, db, await loadConfig(CORPUS), () => {});
      const sec = (Date.now() - t0) / 1000;
      (db as any).db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const mb = statSync(join(armDir, "index.db")).size / 1e6;
      const k = await runBenchmark(kw, db, CORPUS, 10, 0.5);
      const s = await runBenchmark(sem, db, CORPUS, 10, 0.5);
      db.close();
      rows.push({ label: arm.label, files: idx.indexed, sec, mb, kR: k.recallAtK, kM: k.mrr, sR: s.recallAtK, sM: s.mrr });
      console.log(`done: ${arm.label}  ${sec.toFixed(0)}s  ${mb.toFixed(1)}MB  kw ${(k.recallAtK * 100).toFixed(0)}%/${k.mrr.toFixed(2)}  sem ${(s.recallAtK * 100).toFixed(0)}%/${s.mrr.toFixed(2)}`);
    } catch (e) {
      console.log(`SKIP ${arm.label}: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`);
    }
  }

  console.log("\n" + "=".repeat(92));
  console.log(`${"model".padEnd(30)} ${"index".padStart(7)} ${"db".padStart(8)} ${"kw R@10/MRR".padStart(16)} ${"sem R@10/MRR".padStart(16)}`);
  console.log("-".repeat(92));
  const pct = (x: number) => (x * 100).toFixed(0) + "%";
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(30)} ${(r.sec.toFixed(0) + "s").padStart(7)} ${(r.mb.toFixed(1) + "MB").padStart(8)} ` +
      `${`${pct(r.kR)} / ${r.kM.toFixed(3)}`.padStart(16)} ${`${pct(r.sR)} / ${r.sM.toFixed(3)}`.padStart(16)}`
    );
  }
  console.log("\n(semantic R@10 is the 'win on intent' metric; db size is per-project cost; index time scales per repo)");
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(CORPUS, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
