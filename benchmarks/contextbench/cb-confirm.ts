/**
 * ContextBench confirm (plans/retrieval-ab-harness.md RESULTS). Scores the leaf
 * and PPR arms on the REAL multi-file line-gold for the 15 cached instances in
 * repos/cb-repos, using their existing (preamble-off) indexes — no re-clone, no
 * re-index. Gold dumped from contextbench_verified.parquet -> /tmp/cb-gold/*.json
 * ({instance_id, problem_statement, gold:[{file,start,end}]}).
 *
 *   - leaf arm: searchChunks default vs leafOnly -> file & LINE cov/prec + chars
 *   - PPR arm : search() file ranking, baseline vs 1-hop vs PPR -> fileCov/prec/MRR
 *               (this is the multi-file "recover the imported helper" test the
 *                single-file query sets could not exercise)
 *
 * Run: bun benchmarks/contextbench/cb-confirm.ts
 */
import { readFileSync, readdirSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const GOLD = "/tmp/cb-gold";
const K = 10;

interface Gold { instance_id: string; dir: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }

function hit(p: string, e: string) { return p === e || p.endsWith("/" + e) || p.endsWith(e); }

// ---- PPR over file import graph (same as ab-runner) ----
function buildGraph(db: RagDB) {
  const g = db.getGraph();
  const idx = new Map<string, number>();
  for (const n of g.nodes) if (!idx.has(n.path)) idx.set(n.path, idx.size);
  const adj: number[][] = Array.from({ length: idx.size }, () => []);
  for (const e of g.edges) {
    const a = idx.get(e.fromPath), b = idx.get(e.toPath);
    if (a == null || b == null || a === b) continue;
    adj[a].push(b); adj[b].push(a);
  }
  return { idx, adj, paths: [...idx.keys()], N: idx.size };
}
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
      const sh = r[j] / adj[j].length;
      for (const k of adj[j]) next[k] += sh;
    }
    for (let i = 0; i < N; i++) next[i] = alpha * p[i] + (1 - alpha) * (next[i] + dangling * p[i]);
    r = next;
  }
  return r;
}

interface FileScore { fileCov: number; filePrec: number; mrr: number }
function scoreFiles(rankedFiles: string[], goldFiles: string[]): FileScore {
  const topK = rankedFiles.slice(0, K);
  const covered = goldFiles.filter((g) => topK.some((f) => hit(f, g))).length;
  const inter = topK.filter((f) => goldFiles.some((g) => hit(f, g))).length;
  let rank = 0;
  for (let i = 0; i < rankedFiles.length; i++) if (goldFiles.some((g) => hit(rankedFiles[i], g))) { rank = i + 1; break; }
  return {
    fileCov: goldFiles.length ? covered / goldFiles.length : 0,
    filePrec: topK.length ? inter / topK.length : 0,
    mrr: rank ? 1 / rank : 0,
  };
}

async function main() {
  const golds = readdirSync(GOLD).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`${GOLD}/${f}`, "utf8")) as Gold);
  console.log(`CB confirm: ${golds.length} instances, K=${K}\n`);

  // accumulators
  const leafAcc = { def: { fileCov: 0, linePrec: 0, lineCov: 0, chars: 0 }, leaf: { fileCov: 0, linePrec: 0, lineCov: 0, chars: 0 } };
  const fileAcc: Record<string, FileScore & { n: number }> = {};
  const addF = (k: string, s: FileScore) => { const a = (fileAcc[k] ??= { fileCov: 0, filePrec: 0, mrr: 0, n: 0 }); a.fileCov += s.fileCov; a.filePrec += s.filePrec; a.mrr += s.mrr; a.n++; };

  console.log(`instance              gFiles  base_cov  ppr_cov   1hop_cov   leaf_linePrec  def_linePrec`);
  for (const g of golds) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const goldFiles = [...new Set(g.gold.map((x) => x.file))];
    const goldLines = new Map<string, Set<number>>();
    for (const x of g.gold) { const s = goldLines.get(x.file) ?? new Set<number>(); for (let i = x.start; i <= x.end; i++) s.add(i); goldLines.set(x.file, s); }
    const totalGoldLines = [...goldLines.values()].reduce((a, s) => a + s.size, 0);

    // ---- leaf arm (line metrics) ----
    async function chunkScore(leaf: boolean) {
      const chunks = await searchChunks(g.problem_statement, db, 20, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount ?? 2, leaf);
      const predFiles = new Set<string>();
      let predLines = 0, hitLines = 0, chars = 0;
      const goldHit = new Set<string>();
      for (const c of chunks) {
        chars += c.content.length;
        if (c.startLine == null || c.endLine == null) continue;
        const rel = c.path.startsWith(dir) ? c.path.slice(dir.length + 1) : c.path;
        predFiles.add(rel);
        const gl = goldLines.get(rel);
        for (let i = c.startLine; i <= c.endLine; i++) { predLines++; if (gl?.has(i)) { hitLines++; goldHit.add(`${rel}:${i}`); } }
      }
      const fileCov = goldFiles.filter((f) => [...predFiles].some((p) => hit(p, f))).length / goldFiles.length;
      return { fileCov, lineCov: totalGoldLines ? goldHit.size / totalGoldLines : 0, linePrec: predLines ? hitLines / predLines : 0, chars };
    }
    const def = await chunkScore(false), leaf = await chunkScore(true);
    for (const m of ["fileCov", "linePrec", "lineCov", "chars"] as const) { leafAcc.def[m] += def[m]; leafAcc.leaf[m] += leaf[m]; }

    // ---- PPR arm (file metrics) ----
    const pool = await search(g.problem_statement, db, 40, 0, cfg.hybridWeight, cfg.generated);
    const graph = buildGraph(db);
    const baseFiles = pool.map((r) => r.path);
    function pprRerank(alpha: number, beta: number, nb: boolean): string[] {
      const maxH = pool.length ? pool[0].score : 1;
      const hybrid = new Map<string, number>(pool.map((r) => [r.path, r.score / (maxH || 1)]));
      const seed = new Map<number, number>();
      for (const r of pool.slice(0, 15)) { const i = graph.idx.get(r.path); if (i != null) seed.set(i, r.score); }
      const rr = ppr(graph.adj, graph.N, seed, alpha, 25);
      const cand = new Set(pool.map((x) => x.path));
      if (nb) for (const t of pool.slice(0, 8)) { const i = graph.idx.get(t.path); if (i != null) for (const k of graph.adj[i]) cand.add(graph.paths[k]); }
      let maxP = 0; for (const pth of cand) { const i = graph.idx.get(pth); if (i != null) maxP = Math.max(maxP, rr[i]); }
      return [...cand].map((pth) => { const i = graph.idx.get(pth); const pN = i != null && maxP > 0 ? rr[i] / maxP : 0; return { pth, sc: (1 - beta) * (hybrid.get(pth) ?? 0) + beta * pN }; })
        .sort((a, b) => b.sc - a.sc).map((x) => x.pth);
    }
    const baseS = scoreFiles(baseFiles, goldFiles); addF("baseline", baseS);
    addF("1hop b.05", scoreFiles(pprRerank(0.15, 0.05, true), goldFiles));
    const pprS = scoreFiles(pprRerank(0.15, 0.20, true), goldFiles); addF("ppr b.20", pprS);
    addF("ppr b.35", scoreFiles(pprRerank(0.15, 0.35, true), goldFiles));

    console.log(`${g.dir.padEnd(20)}  ${String(goldFiles.length).padStart(5)}   ${(baseS.fileCov*100).toFixed(0).padStart(6)}%  ${(pprS.fileCov*100).toFixed(0).padStart(6)}%   ${"".padStart(6)}    ${(leaf.linePrec*100).toFixed(1).padStart(6)}%       ${(def.linePrec*100).toFixed(1).padStart(6)}%`);
    db.close();
  }

  const n = golds.length;
  console.log(`\n=== LEAF arm (line metrics, mean over ${n}) ===`);
  console.log(`mode      fileCov   lineCov   linePrec   chars/q`);
  for (const [lbl, a] of [["default", leafAcc.def], ["leaf", leafAcc.leaf]] as const)
    console.log(`${lbl.padEnd(8)}  ${(a.fileCov/n*100).toFixed(1).padStart(5)}%   ${(a.lineCov/n*100).toFixed(1).padStart(5)}%   ${(a.linePrec/n*100).toFixed(1).padStart(6)}%   ${(a.chars/n).toFixed(0).padStart(7)}`);

  console.log(`\n=== PPR arm (file metrics, mean over ${n}) ===`);
  console.log(`arm         fileCov@${K}  filePrec@${K}   MRR`);
  for (const [k, a] of Object.entries(fileAcc))
    console.log(`${k.padEnd(11)}  ${(a.fileCov/a.n*100).toFixed(1).padStart(6)}%   ${(a.filePrec/a.n*100).toFixed(1).padStart(6)}%   ${(a.mrr/a.n).toFixed(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
