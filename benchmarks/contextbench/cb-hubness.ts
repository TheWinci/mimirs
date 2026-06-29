/**
 * A/B: does HUBNESS DEMOTION lift ContextBench file ranking?
 *
 * Idea (the user's "demote the wrong files" axis): the wall is RANKING not recall
 * — gold sits in the pool but noise outranks it. CSLS / anti-hub reranking sinks
 * "hub" chunks (vectors that live in a dense generic region of the corpus and so
 * are near-neighbour to too many queries) below gold, instead of trying to lift
 * gold. Query-independent, precomputable, ~zero query latency — respects the
 * cross-encoder 3s lesson.
 *
 * Per candidate chunk c: hub(c) = mean cosine of c to its top-K nearest corpus
 * neighbours (optionally excluding same-file neighbours, so it measures cross-file
 * genericness not within-class self-similarity). Rerank score = cos(q,c) − λ·hub(c).
 *
 * Isolation arm: pure-vector channel (no BM25), so the demotion effect is not
 * masked by fusion. Baseline = same pool ranked by cos only. We also print the
 * product hybrid search() numbers for reference.
 *
 * hub(c) computed LAZILY only for chunks that appear in some query's pool (~POOL
 * per query), cached per repo. cos = 1 − L2²/2 (vectors are unit-normalized).
 *
 * Run: bun benchmarks/contextbench/cb-hubness.ts
 */
import { readFileSync } from "fs";
import type { Database } from "bun:sqlite";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";
import { embed } from "../../src/embeddings/embed";
import { embeddingBytes } from "../../src/utils/vec";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

const POOL = 200;       // candidate chunk depth per query
const KNN_K = 10;       // neighbours used for hub
const KNN_FETCH = 60;   // over-fetch so same-file exclusion still leaves K
const EXCLUDE_SAME_FILE = true;
const LAMBDAS = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0];

const blob2vec = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

interface Cand { chunkId: number; fileId: number; path: string; cos: number }

function poolFor(db: Database, qEmb: Float32Array): Cand[] {
  const rows = db.query<{ chunk_id: number; distance: number; file_id: number; path: string }, [Uint8Array, number]>(
    `SELECT v.chunk_id, v.distance, c.file_id, f.path
     FROM (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
     JOIN chunks c ON c.id = v.chunk_id JOIN files f ON f.id = c.file_id
     ORDER BY v.distance`
  ).all(embeddingBytes(qEmb), POOL);
  return rows.map((r) => ({ chunkId: r.chunk_id, fileId: r.file_id, path: r.path, cos: 1 - (r.distance * r.distance) / 2 }));
}

function hubOf(db: Database, chunkId: number, fileId: number, cache: Map<number, number>): number {
  const cached = cache.get(chunkId);
  if (cached !== undefined) return cached;
  const emb = db.query<{ embedding: Uint8Array }, [number]>("SELECT embedding FROM vec_chunks WHERE chunk_id = ?").get(chunkId);
  if (!emb) { cache.set(chunkId, 0); return 0; }
  const vec = blob2vec(emb.embedding);
  const nbrs = db.query<{ chunk_id: number; distance: number; file_id: number }, [Uint8Array, number]>(
    `SELECT v.chunk_id, v.distance, c.file_id
     FROM (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
     JOIN chunks c ON c.id = v.chunk_id ORDER BY v.distance`
  ).all(embeddingBytes(vec), KNN_FETCH);
  let sum = 0, k = 0;
  for (const nb of nbrs) {
    if (nb.chunk_id === chunkId) continue;            // self
    if (EXCLUDE_SAME_FILE && nb.file_id === fileId) continue;
    sum += 1 - (nb.distance * nb.distance) / 2;        // cosine
    if (++k >= KNN_K) break;
  }
  const hub = k ? sum / k : 0;
  cache.set(chunkId, hub);
  return hub;
}

// collapse chunk scores -> file ranking by MAX score per file
function rankFiles(cands: { path: string; score: number }[]): string[] {
  const best = new Map<string, number>();
  for (const c of cands) { const b = best.get(c.path); if (b === undefined || c.score > b) best.set(c.path, c.score); }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

function covPrec(ranked: string[], goldFiles: string[], k: number) {
  const pred = ranked.slice(0, k);
  const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length;
  return { cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0, prec: pred.length ? inter / pred.length : 0 };
}
const goldRanks = (ranked: string[], goldFiles: string[]) =>
  goldFiles.map((gf) => { for (let i = 0; i < ranked.length; i++) if (hit(ranked[i], gf)) return i + 1; return 0; });

interface Acc { c8: number; p8: number; c12: number; p12: number }
const zero = (): Acc => ({ c8: 0, p8: 0, c12: 0, p12: 0 });
function add(a: Acc, ranked: string[], goldFiles: string[]) {
  const x8 = covPrec(ranked, goldFiles, 8), x12 = covPrec(ranked, goldFiles, 12);
  a.c8 += x8.cov; a.p8 += x8.prec; a.c12 += x12.cov; a.p12 += x12.prec;
}

async function main() {
  const LIMIT = process.env.CB_LIMIT ? parseInt(process.env.CB_LIMIT, 10) : 0;
  const MULTI = process.env.CB_MULTI === "1"; // only instances with >=2 distinct gold files
  let dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));
  if (MULTI) dataset = dataset.filter((g) => new Set(g.gold.map((x) => x.file)).size >= 2);
  if (LIMIT > 0) dataset = dataset.slice(0, LIMIT);
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const rel = (dir: string) => (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

  for (const mode of ["distilled", "raw"] as const) {
    console.log(`\n========== mode: ${mode}  (POOL=${POOL} K=${KNN_K} exclSameFile=${EXCLUDE_SAME_FILE}) ==========`);
    const prod = zero();      // current hybrid search() — reference
    const baseVec = zero();   // vector-only, cos ranking
    const csls = LAMBDAS.map(zero);
    let n = 0;
    const lines: string[] = [];

    for (const g of dataset) {
      const dir = `${CB}/${g.dir}`;
      const db = new RagDB(dir);
      const sqlite = (db as any).db as Database;
      const cfg = await loadConfig(dir);
      const R = rel(dir);
      const goldFiles = [...new Set(g.gold.map((x) => x.file))];
      const q = mode === "raw" ? g.problem_statement : (queries[g.dir] ?? g.problem_statement);
      n++;

      // product hybrid (reference)
      const prodRanked = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => R(r.path));
      add(prod, prodRanked, goldFiles);

      // vector pool + hub
      const qEmb = await embed(q);
      const pool = poolFor(sqlite, qEmb);
      const cache = new Map<number, number>();

      const baseRanked = rankFiles(pool.map((c) => ({ path: R(c.path), score: c.cos })));
      add(baseVec, baseRanked, goldFiles);

      const cslsRanks: string[] = [];
      LAMBDAS.forEach((lam, li) => {
        const rr = rankFiles(pool.map((c) => ({ path: R(c.path), score: c.cos - lam * hubOf(sqlite, c.chunkId, c.fileId, cache) })));
        add(csls[li], rr, goldFiles);
        if (Math.abs(lam - 0.3) < 1e-9) cslsRanks.push(`${goldRanks(rr, goldFiles).join(",")}`);
      });
      if (mode === "distilled")
        lines.push(`  ${g.dir.padEnd(20)} gold=${goldFiles.length}  prod=[${goldRanks(prodRanked, goldFiles).join(",")}] vec=[${goldRanks(baseRanked, goldFiles).join(",")}] csls.3=[${cslsRanks[0]}]`);
      db.close();
    }

    const pct = (v: number) => (v / n * 100).toFixed(1).padStart(6) + "%";
    const row = (name: string, a: Acc) => console.log(`  ${name.padEnd(16)} ${pct(a.c8)} ${pct(a.p8)} ${pct(a.c12)} ${pct(a.p12)}`);
    console.log(`n=${n}`);
    console.log(`  arm              cov@8  prec@8  cov@12 prec@12`);
    row("prod(hybrid)", prod);
    row("vec(cos only)", baseVec);
    LAMBDAS.forEach((lam, li) => row(`csls λ=${lam}`, csls[li]));
    if (mode === "distilled") { console.log(`  per-instance gold ranks (0=miss):`); for (const l of lines) console.log(l); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
