/**
 * A/B: does a boost-only co-change rerank lift ContextBench file ranking?
 *
 * The wall is RANKING not recall (gold files sit deep in the pool). So we
 * rerank WITHIN the search pool — never inject neighbours (hub noise). For
 * each query: seeds = top-S retrieved files; boost any pooled candidate by
 *   Σ_seed jaccard(seed, cand) * score(seed).
 * Co-change graph is built from each repo's git log — leak-safe history
 * prepped in /tmp/cc-<dir> (unshallow + pruned to HEAD ancestry, no fix commit).
 *
 * File search runs on the CANONICAL .mimirs (paths match cb-score's rel()).
 * Only the git log comes from the scratch copy. No embeddings needed.
 *
 * Run: bun benchmarks/contextbench/cb-cochange.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

// ── co-change graph from a repo's git log (mirrors getCoChangedFiles) ──
interface CoGraph { jaccard(a: string, b: string): number; neighbours(f: string): { file: string; jaccard: number }[]; }
function buildCoGraph(gitDir: string, maxCommitFiles = 25): CoGraph {
  const out = execFileSync("git", ["-C", gitDir, "log", "HEAD", "--no-merges", "--name-only", "--pretty=format:@@@%H"], { maxBuffer: 1 << 30 }).toString();
  const commits: string[][] = [];
  let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@@")) { if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur); cur = []; }
    else if (line.trim()) cur?.push(line.trim());
  }
  if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur);

  const count = new Map<string, number>();
  const idx = new Map<string, number[]>(); // file -> commit indices
  commits.forEach((files, i) => {
    for (const f of new Set(files)) {
      count.set(f, (count.get(f) ?? 0) + 1);
      (idx.get(f) ?? idx.set(f, []).get(f)!).push(i);
    }
  });
  const together = (a: string, b: string): number => {
    const ia = idx.get(a); if (!ia) return 0;
    const setB = new Set(idx.get(b) ?? []);
    let n = 0; for (const i of ia) if (setB.has(i)) n++; return n;
  };
  const jaccard = (a: string, b: string): number => {
    const t = together(a, b); if (!t) return 0;
    const ca = count.get(a) ?? 0, cb = count.get(b) ?? 0;
    return t / (ca + cb - t);
  };
  const neighbours = (f: string) => {
    const ia = idx.get(f); if (!ia) return [];
    const tally = new Map<string, number>();
    for (const i of ia) for (const g of new Set(commits[i])) if (g !== f) tally.set(g, (tally.get(g) ?? 0) + 1);
    const cf = count.get(f) ?? 0;
    return [...tally].filter(([, t]) => t >= 2).map(([g, t]) => ({ file: g, jaccard: t / (cf + (count.get(g) ?? 0) - t) })).sort((a, b) => b.jaccard - a.jaccard);
  };
  return { jaccard, neighbours };
}

function covPrec(ranked: string[], goldFiles: string[], k: number) {
  const pred = ranked.slice(0, k);
  const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length;
  return { cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0, prec: pred.length ? inter / pred.length : 0 };
}

// rerank. mult=true → newScore = score*(1 + alpha*Σjaccard) (gentle, order-preserving);
// mult=false → additive newScore = score + alpha*Σ(jaccard*seedScore).
function rerank(pool: { path: string; score: number }[], co: CoGraph, S: number, alpha: number, floor: number, mult: boolean): string[] {
  const seeds = pool.slice(0, S);
  const boosted = pool.map((c) => {
    let bAdd = 0, bMul = 0;
    for (const s of seeds) {
      if (s.path === c.path) continue;
      const j = co.jaccard(s.path, c.path);
      if (j >= floor) { bAdd += j * s.score; bMul += j; }
    }
    return { path: c.path, score: mult ? c.score * (1 + alpha * bMul) : c.score + alpha * bAdd };
  });
  return boosted.sort((a, b) => b.score - a.score).map((r) => r.path);
}

// ≥2-distinct-gold instances only (co-change is about multi-file coupling)
const MULTI = new Set(["astropy-deb49033", "matplotlib-bebfd692", "pylint-da598baa", "pylint-1409977d", "requests-e989ba2d", "xarray-42c77239", "xarray-90532e38"]);

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).filter((g) => MULTI.has(g.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const SWEEP = [
    { S: 3, alpha: 0.1, floor: 0.05, mult: true },
    { S: 3, alpha: 0.25, floor: 0.05, mult: true },
    { S: 3, alpha: 0.5, floor: 0.05, mult: true },
    { S: 5, alpha: 0.25, floor: 0.1, mult: true },
    { S: 1, alpha: 0.25, floor: 0.05, mult: true },
    { S: 3, alpha: 4, floor: 0.05, mult: false },
  ];

  for (const mode of ["raw", "distilled"] as const) {
    console.log(`\n========== mode: ${mode} ==========`);
    const base = { c8: 0, p8: 0, c12: 0, p12: 0 };
    const rer = SWEEP.map(() => ({ c8: 0, p8: 0, c12: 0, p12: 0 }));
    let n = 0;
    const lines: string[] = [];

    for (const g of dataset) {
      const scratch = `/tmp/cc-${g.dir}`;
      if (!existsSync(`${scratch}/.git`)) { lines.push(`  ${g.dir.padEnd(20)} SKIP (no scratch git)`); continue; }
      n++;
      const dir = `${CB}/${g.dir}`;
      const db = new RagDB(dir);
      const cfg = await loadConfig(dir);
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      const goldFiles = [...new Set(g.gold.map((x) => x.file))];
      const q = mode === "raw" ? g.problem_statement : (queries[g.dir] ?? g.problem_statement);

      const pool = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => ({ path: rel(r.path), score: r.score }));
      const co = buildCoGraph(scratch);

      const bRanked = pool.map((r) => r.path);
      const b8 = covPrec(bRanked, goldFiles, 8), b12 = covPrec(bRanked, goldFiles, 12);
      base.c8 += b8.cov; base.p8 += b8.prec; base.c12 += b12.cov; base.p12 += b12.prec;

      const goldRankBase = goldFiles.map((gf) => { for (let i = 0; i < bRanked.length; i++) if (hit(bRanked[i], gf)) return i + 1; return 0; });
      const sweepRanks: string[] = [];
      SWEEP.forEach((cfgSw, si) => {
        const rRanked = rerank(pool, co, cfgSw.S, cfgSw.alpha, cfgSw.floor, cfgSw.mult);
        const r8 = covPrec(rRanked, goldFiles, 8), r12 = covPrec(rRanked, goldFiles, 12);
        rer[si].c8 += r8.cov; rer[si].p8 += r8.prec; rer[si].c12 += r12.cov; rer[si].p12 += r12.prec;
        if (si === 1) { // show S3/a8/f.05 per-instance
          const grR = goldFiles.map((gf) => { for (let i = 0; i < rRanked.length; i++) if (hit(rRanked[i], gf)) return i + 1; return 0; });
          sweepRanks.push(`base=[${goldRankBase.join(",")}] -> rerank=[${grR.join(",")}]`);
        }
      });
      lines.push(`  ${g.dir.padEnd(20)} gold=${goldFiles.length}  ${sweepRanks[0]}`);
      db.close();
    }

    const pct = (v: number) => (v / n * 100).toFixed(1).padStart(6) + "%";
    console.log(`n=${n}`);
    console.log(`  arm                 cov@8   prec@8  cov@12  prec@12`);
    console.log(`  baseline           ${pct(base.c8)} ${pct(base.p8)} ${pct(base.c12)} ${pct(base.p12)}`);
    SWEEP.forEach((s, i) => {
      const a = rer[i];
      console.log(`  ${s.mult ? "x" : "+"}S${s.S} a${s.alpha} f${s.floor}        `.slice(0, 21) + `${pct(a.c8)} ${pct(a.p8)} ${pct(a.c12)} ${pct(a.p12)}`);
    });
    console.log(`  per-instance gold ranks (0=miss; col = S3/a8/f.05):`);
    for (const l of lines) console.log(l);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
