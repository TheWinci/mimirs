/**
 * A/B runner for the three borrowed-retrieval-ideas plan
 * (plans/retrieval-ab-harness.md). Runs on the repo's OWN index + a checked-in
 * query set (file-level gold), so it needs no ContextBench fixture / re-clone.
 *
 * Reports, per arm, on the SAME query set (deterministic retrieval -> exact deltas):
 *   recall@10 (file), MRR, zero-miss, mean contentChars (token proxy), p50 latency.
 *
 * Arms:
 *   - baseline : search() file-level (already has log2-importer graph boost)
 *   - leaf     : searchChunks leafOnly on/off  -> recall hold + contentChars drop
 *   - ppr      : Personalized PageRank rerank over the import graph (+1-hop
 *                recovery of neighbours), sweep blend beta; must beat baseline.
 *
 * Run:  bun benchmarks/contextbench/ab-runner.ts [dir] [queries.json]
 *   default dir = cwd, default queries = benchmarks/mimirs-queries.json
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

interface Q { query: string; expected: string[] }

const dir = resolve(process.argv[2] ?? process.cwd());
const queriesPath = process.argv[3] ?? "benchmarks/mimirs-queries.json";
const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as Q[];

const K = 10;

/** suffix-tolerant file match (gold is repo-relative, results may be absolute) */
function hit(resultPath: string, expected: string): boolean {
  return resultPath === expected || resultPath.endsWith("/" + expected) || resultPath.endsWith(expected);
}
function firstRank(files: string[], expected: string[]): number {
  for (let i = 0; i < files.length; i++) if (expected.some((e) => hit(files[i], e))) return i + 1;
  return 0;
}
function recallAtK(files: string[], expected: string[], k: number): number {
  const top = files.slice(0, k);
  const found = expected.filter((e) => top.some((f) => hit(f, e)));
  return expected.length ? found.length / expected.length : 0;
}

interface Agg { recall: number; mrr: number; zeroMiss: number; chars: number; p50: number; label: string }
function summarize(label: string, perQ: { files: string[]; expected: string[]; chars: number; ms: number }[]): Agg {
  let recall = 0, mrr = 0, zero = 0;
  const lat: number[] = [];
  let chars = 0;
  for (const r of perQ) {
    const rk = firstRank(r.files, r.expected);
    recall += recallAtK(r.files, r.expected, K);
    mrr += rk ? 1 / rk : 0;
    if (!rk || rk > K) zero++;
    chars += r.chars;
    lat.push(r.ms);
  }
  lat.sort((a, b) => a - b);
  const n = perQ.length;
  return { label, recall: recall / n, mrr: mrr / n, zeroMiss: zero / n, chars: chars / n, p50: lat[Math.floor(n / 2)] };
}

// ---- PPR over the file import graph -------------------------------------
function buildGraph(db: RagDB) {
  const g = db.getGraph();
  const idx = new Map<string, number>();
  for (const node of g.nodes) if (!idx.has(node.path)) idx.set(node.path, idx.size);
  const N = idx.size;
  const adj: number[][] = Array.from({ length: N }, () => []);
  for (const e of g.edges) {
    const a = idx.get(e.fromPath), b = idx.get(e.toPath);
    if (a == null || b == null || a === b) continue;
    adj[a].push(b); adj[b].push(a); // undirected: importer & imported are both topically related
  }
  const paths = Array.from(idx.keys());
  return { idx, adj, paths, N };
}

/** personalized pagerank: r = alpha*p + (1-alpha)*M r  (M = uniform over neighbours) */
function ppr(adj: number[][], N: number, seed: Map<number, number>, alpha: number, iters: number): Float64Array {
  const p = new Float64Array(N);
  let s = 0; for (const v of seed.values()) s += v;
  if (s <= 0) return p;
  for (const [i, v] of seed) p[i] = v / s;
  let r = Float64Array.from(p);
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(N);
    let dangling = 0;
    for (let j = 0; j < N; j++) {
      if (adj[j].length === 0) { dangling += r[j]; continue; }
      const share = r[j] / adj[j].length;
      for (const k of adj[j]) next[k] += share;
    }
    for (let i = 0; i < N; i++) next[i] = alpha * p[i] + (1 - alpha) * (next[i] + dangling * p[i]);
    r = next;
  }
  return r;
}

async function main() {
  const db = new RagDB(dir);
  const cfg = await loadConfig(dir);
  console.log(`dir=${dir}\nqueries=${queriesPath} (${queries.length})  K=${K}  weight=${cfg.hybridWeight}\n`);

  const graph = buildGraph(db);
  console.log(`import graph: ${graph.N} nodes\n`);

  // ---------- BASELINE: file-level search() ----------
  const basePer: { files: string[]; expected: string[]; chars: number; ms: number }[] = [];
  // cache the file-level pool per query for the PPR arm (avoid re-running search)
  const pools: { ranked: { path: string; score: number }[]; expected: string[] }[] = [];
  for (const q of queries) {
    const t = performance.now();
    const res = await search(q.query, db, 40, 0, cfg.hybridWeight, cfg.generated);
    const ms = performance.now() - t;
    const files = res.map((r) => r.path);
    basePer.push({ files, expected: q.expected, chars: 0, ms });
    pools.push({ ranked: res.map((r) => ({ path: r.path, score: r.score })), expected: q.expected });
  }

  // ---------- LEAF: searchChunks default vs leafOnly ----------
  async function chunkArm(leafOnly: boolean) {
    const per: { files: string[]; expected: string[]; chars: number; ms: number }[] = [];
    for (const q of queries) {
      const t = performance.now();
      const chunks = await searchChunks(q.query, db, 20, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount ?? 2, leafOnly);
      const ms = performance.now() - t;
      const files: string[] = [];
      let chars = 0;
      for (const c of chunks) { chars += c.content.length; if (!files.includes(c.path)) files.push(c.path); }
      per.push({ files, expected: q.expected, chars, ms });
    }
    return per;
  }
  const chunkDefault = await chunkArm(false);
  const chunkLeaf = await chunkArm(true);

  // ---------- PPR rerank over baseline pool ----------
  function pprArm(alpha: number, beta: number, addNeighbours: boolean) {
    const per: { files: string[]; expected: string[]; chars: number; ms: number }[] = [];
    for (const pool of pools) {
      const t = performance.now();
      const hybrid = new Map<string, number>();
      const maxH = pool.ranked.length ? pool.ranked[0].score : 1;
      for (const r of pool.ranked) hybrid.set(r.path, r.score / (maxH || 1));
      // seed PPR with top-pool files weighted by hybrid score
      const seed = new Map<number, number>();
      for (const r of pool.ranked.slice(0, 15)) {
        const i = graph.idx.get(r.path); if (i != null) seed.set(i, r.score);
      }
      const r = ppr(graph.adj, graph.N, seed, alpha, 25);
      // candidate set = pool ∪ (optionally) 1-hop neighbours of top hits
      const cand = new Set(pool.ranked.map((x) => x.path));
      if (addNeighbours) {
        for (const top of pool.ranked.slice(0, 8)) {
          const i = graph.idx.get(top.path); if (i == null) continue;
          for (const nb of graph.adj[i]) cand.add(graph.paths[nb]);
        }
      }
      let maxP = 0;
      for (const path of cand) { const i = graph.idx.get(path); if (i != null) maxP = Math.max(maxP, r[i]); }
      const scored = [...cand].map((path) => {
        const i = graph.idx.get(path);
        const pNorm = i != null && maxP > 0 ? r[i] / maxP : 0;
        const hNorm = hybrid.get(path) ?? 0;
        return { path, score: (1 - beta) * hNorm + beta * pNorm };
      });
      scored.sort((a, b) => b.score - a.score);
      const ms = performance.now() - t;
      per.push({ files: scored.map((s) => s.path), expected: pool.expected, chars: 0, ms });
    }
    return per;
  }
  // 1-hop expansion baseline to beat: add neighbours but pure-hybrid order (beta=0
  // can't reorder; use a tiny graph nudge = applyGraphBoost is already in baseline,
  // so the honest "cheap" comparison is neighbours added + small beta).
  const oneHop = pprArm(0.15, 0.05, true);

  const rows: Agg[] = [
    summarize("baseline (search)", basePer),
    summarize("chunk-default", chunkDefault),
    summarize("chunk-LEAF", chunkLeaf),
    summarize("1hop-expand b.05", oneHop),
    summarize("ppr a.15 b.20 +nb", pprArm(0.15, 0.20, true)),
    summarize("ppr a.15 b.35 +nb", pprArm(0.15, 0.35, true)),
    summarize("ppr a.15 b.50 +nb", pprArm(0.15, 0.50, true)),
    summarize("ppr a.30 b.35 +nb", pprArm(0.30, 0.35, true)),
    summarize("ppr a.15 b.35 noNb", pprArm(0.15, 0.35, false)),
  ];

  console.log(`arm                   recall@10    MRR   zeroMiss   chars/q   p50ms`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(20)}  ${(r.recall * 100).toFixed(1).padStart(6)}%  ${r.mrr.toFixed(3)}   ${(r.zeroMiss * 100).toFixed(1).padStart(5)}%  ${r.chars ? r.chars.toFixed(0).padStart(7) : "      -"}   ${r.p50.toFixed(1).padStart(5)}`
    );
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
