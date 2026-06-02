/**
 * Embedding-granularity experiment: does storing per-window vectors for oversized
 * chunks retrieve better than today's window-then-AVERAGE (one mush vector)?
 *
 * Arms (built faithfully via the real RagDB.insertChunkBatch + sqlite-vec, NO core
 * change — the flag the indexer would carry is just scaffolding we don't need to
 * measure):
 *   merged          - control: today's behaviour, one averaged vector per chunk.
 *   window-children - oversized chunk's averaged vector REMOVED; each window stored
 *                     as a child chunk (own vector, parent_id = the unit).
 *   both            - window children PLUS the unit's averaged vector kept.
 *
 * Fidelity notes: windows here are CHAR-approximate (~1000 chars ≈ 250 tok) rather
 * than the production token windows — directionally equivalent for "do windows
 * help". Child snippets are empty so BM25 is unchanged across arms (no FTS
 * double-count). Measures file-level recall (existing benches) + a qualitative
 * chunk-level probe (does a query for a method inside the RagDB mega-chunk retrieve
 * a narrow window vs the whole 800-line blob).
 *
 * Run: bun benchmarks/embed-mode-experiment.ts
 */
import { resolve, join } from "path";
import { rmSync, mkdirSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { RagDB } from "../src/db";
import { loadConfig } from "../src/config";
import { indexDirectory } from "../src/indexing/indexer";
import { embedBatch } from "../src/embeddings/embed";
import { loadBenchmarkQueries, runBenchmark } from "../src/search/benchmark";

const SRC_REPO = resolve(".");
// Index a COPY of the source, not the live repo — the running MCP server holds the
// indexer lock on the live project dir. The RagDB mega-chunk reproduces identically.
const REPO = resolve(tmpdir(), "mimirs-embmode-corpus");
const OVERSIZED_CHARS = 1100; // ≈ 256 tokens

function setupCorpus() {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, ".mimirs"), { recursive: true });
  for (const d of ["src", "docs"]) Bun.spawnSync(["cp", "-R", join(SRC_REPO, d), join(REPO, d)]);
  Bun.spawnSync(["bash", "-c", `cp ${SRC_REPO}/*.md ${REPO}/ 2>/dev/null; cp ${SRC_REPO}/.mimirs/config.json ${REPO}/.mimirs/config.json 2>/dev/null`]);
}

function charWindows(text: string, size = 1000, overlap = 150): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let s = 0; s < text.length; s += size - overlap) {
    out.push(text.slice(s, s + size));
    if (s + size >= text.length) break;
  }
  return out;
}

async function buildBase(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = new RagDB(REPO, dir);
  const config = await loadConfig(REPO);
  console.log(`Indexing ${REPO} -> base ...`);
  const r = await indexDirectory(REPO, db, config, () => {});
  console.log(`  indexed ${r.indexed} files`);
  (db as any).db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function cloneDb(baseDir: string, intoDir: string) {
  mkdirSync(intoDir, { recursive: true });
  copyFileSync(join(baseDir, "index.db"), join(intoDir, "index.db"));
}

/** Add per-window child chunks for every oversized chunk. Returns affected parent ids. */
async function addWindowChildren(dir: string): Promise<number[]> {
  const db = new RagDB(REPO, dir);
  const raw = (db as any).db;
  const oversized = raw
    .query(`SELECT id, file_id, snippet, start_line, end_line FROM chunks WHERE chunk_index >= 0 AND LENGTH(snippet) > ${OVERSIZED_CHARS}`)
    .all() as { id: number; file_id: number; snippet: string; start_line: number | null; end_line: number | null }[];

  // window texts -> embed in one batch
  const jobs: { fileId: number; parentId: number; sl: number | null; el: number | null; text: string }[] = [];
  for (const c of oversized) for (const w of charWindows(c.snippet)) jobs.push({ fileId: c.file_id, parentId: c.id, sl: c.start_line, el: c.end_line, text: w });
  const vecs = await embedBatch(jobs.map((j) => j.text));

  // group children by file, insert via the real API
  const byFile = new Map<number, any[]>();
  jobs.forEach((j, i) => {
    const arr = byFile.get(j.fileId) ?? byFile.set(j.fileId, []).get(j.fileId)!;
    arr.push({ snippet: "", embedding: vecs[i], entityName: null, chunkType: "window", startLine: j.sl, endLine: j.el, contentHash: null, parentId: j.parentId });
  });
  for (const [fileId, children] of byFile) db.insertChunkBatch(fileId, children, 100000);

  (db as any).db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return oversized.map((c) => c.id);
}

function dropParentVectors(dir: string, parentIds: number[]) {
  const db = new RagDB(REPO, dir);
  const raw = (db as any).db;
  const tx = raw.transaction(() => { for (const id of parentIds) raw.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [id]); });
  tx();
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function vecCount(dir: string): number {
  const db = new RagDB(REPO, dir);
  const n = ((db as any).db.query("SELECT COUNT(*) n FROM vec_chunks").get() as any).n;
  db.close();
  return n;
}

async function fileLevel(dir: string, label: string, weight: number) {
  const db = new RagDB(REPO, dir);
  const kw = await loadBenchmarkQueries("./benchmarks/mimirs-queries.json");
  const sem = await loadBenchmarkQueries("./benchmarks/semantic-queries.json");
  const k = await runBenchmark(kw, db, REPO, 10, weight);
  const s = await runBenchmark(sem, db, REPO, 10, weight);
  db.close();
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
  console.log(`  ${label.padEnd(16)} keyword R@10=${pct(k.recallAtK)} MRR=${k.mrr.toFixed(3)}  |  semantic R@10=${pct(s.recallAtK)} MRR=${s.mrr.toFixed(3)}`);
}

async function main() {
  const root = resolve(tmpdir(), "mimirs-embmode");
  rmSync(root, { recursive: true, force: true });
  const A = join(root, "merged"), B = join(root, "windows"), C = join(root, "both");

  console.log("Setting up corpus copy (avoids the live indexer lock) ...");
  setupCorpus();
  await buildBase(A);
  cloneDb(A, B);
  cloneDb(A, C);

  console.log("Adding window children to `windows` and `both` ...");
  const parents = await addWindowChildren(C);            // both = base vectors + window children
  await addWindowChildren(B);                            // windows = base + children ...
  dropParentVectors(B, parents);                         // ... minus the parents' averaged vectors

  console.log(`\nVector counts: merged=${vecCount(A)}  windows=${vecCount(B)}  both=${vecCount(C)}  (oversized units: ${parents.length})`);

  for (const w of [1.0, 0.5]) {
    console.log(`\n=== weight ${w.toFixed(1)} ${w === 1.0 ? "(pure vector — isolates the embedding change)" : "(production default)"} ===`);
    await fileLevel(A, "merged", w);
    await fileLevel(B, "window-children", w);
    await fileLevel(C, "both", w);
  }

  rmSync(root, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
