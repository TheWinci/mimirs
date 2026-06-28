/**
 * Expansion PRECISION. cb-reach proved 74% of missing gold is reachable from
 * the top-3 seed via import-1hop ∪ co-change. But reachability ignores noise:
 * expanding a seed in a 1000-node graph also drags in many non-gold neighbours.
 * This asks the precision question in three parts:
 *
 *   (1) raw channel S/N : of the NEW files expansion adds (not in baseline top-8),
 *       what fraction are gold? How many noise files per recovered gold?
 *   (2) ranked expansion: score each new candidate by connection strength
 *       (impDegree = #seeds importing it; coSum = Σ jaccard to seeds). Do gold
 *       neighbours outrank noise neighbours? precision@1/3/5 of the expansion list.
 *   (3) end-to-end      : merge final = baseNorm + γ*connNorm over pool ∪ expansion,
 *       re-rank, report cov/prec@8/@12 vs baseline. γ=0 must reproduce baseline.
 *
 * Connection channels + leak-safe co-change identical to cb-reach / cb-cochange.
 * Run: bun benchmarks/contextbench/cb-expand.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);
const SEED_K = 3, CO_FLOOR = 0.05, CO_W = 3; // co-sum scaled to ~import-degree range
const MULTI = new Set(["astropy-deb49033", "matplotlib-bebfd692", "pylint-da598baa", "pylint-1409977d", "requests-e989ba2d", "xarray-42c77239", "xarray-90532e38"]);

function buildCoGraph(gitDir: string, maxCommitFiles = 25) {
  const out = execFileSync("git", ["-C", gitDir, "log", "HEAD", "--no-merges", "--name-only", "--pretty=format:@@@%H"], { maxBuffer: 1 << 30 }).toString();
  const commits: string[][] = []; let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@@")) { if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur); cur = []; }
    else if (line.trim()) cur?.push(line.trim());
  }
  if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur);
  const count = new Map<string, number>(); const idx = new Map<string, number[]>();
  commits.forEach((files, i) => { for (const f of new Set(files)) { count.set(f, (count.get(f) ?? 0) + 1); (idx.get(f) ?? idx.set(f, []).get(f)!).push(i); } });
  const jaccard = (a: string, b: string): number => {
    const ia = idx.get(a); if (!ia) return 0; const setB = new Set(idx.get(b) ?? []);
    let t = 0; for (const i of ia) if (setB.has(i)) t++; if (!t) return 0;
    return t / ((count.get(a) ?? 0) + (count.get(b) ?? 0) - t);
  };
  const neighbours = (f: string): { file: string; jaccard: number }[] => {
    const ia = idx.get(f); if (!ia) return []; const tally = new Map<string, number>();
    for (const i of ia) for (const g of new Set(commits[i])) if (g !== f) tally.set(g, (tally.get(g) ?? 0) + 1);
    const cf = count.get(f) ?? 0;
    return [...tally].filter(([, t]) => t >= 2).map(([g, t]) => ({ file: g, jaccard: t / (cf + (count.get(g) ?? 0) - t) }));
  };
  return { jaccard, neighbours };
}

function buildImportAdj(db: RagDB, rel: (p: string) => string): Map<string, Set<string>> {
  const g = db.getGraph();
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); };
  for (const e of g.edges as any[]) {
    const a = rel(e.fromPath), b = rel(e.toPath); if (a === b) continue;
    add(a, b); add(b, a);
  }
  return adj;
}

function covPrec(ranked: string[], gold: string[], k: number) {
  const pred = ranked.slice(0, k);
  const inter = pred.filter((f) => gold.some((gf) => hit(f, gf))).length;
  return { cov: gold.length ? gold.filter((gf) => pred.some((f) => hit(f, gf))).length / gold.length : 0, prec: pred.length ? inter / pred.length : 0 };
}

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).filter((g) => MULTI.has(g.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const GAMMAS = [0, 0.3, 0.6, 1.0];

  // aggregates
  let newTotal = 0, newGold = 0;                          // (1) raw channel S/N
  const expP = { at1: 0, at3: 0, at5: 0, lists: 0, recovered: 0 }; // (2) ranked expansion
  const ee = GAMMAS.map(() => ({ c8: 0, p8: 0, c12: 0, p12: 0 }));  // (3) end-to-end
  let n = 0;
  const perInst: string[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`, scratch = `/tmp/cc-${g.dir}`;
    const db = new RagDB(dir); const cfg = await loadConfig(dir); n++;
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const isGold = (f: string) => gold.some((gf) => hit(f, gf));

    const pool = (await search(queries[g.dir] ?? g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => ({ path: rel(r.path), score: r.score }));
    const poolPaths = pool.map((p) => p.path);
    const baseTop8 = new Set(poolPaths.slice(0, 8));
    const scoreOf = new Map(pool.map((p) => [p.path, p.score]));
    const maxPool = pool[0]?.score ?? 1;
    const seeds = poolPaths.slice(0, SEED_K);

    const adj = buildImportAdj(db, rel);
    const co = existsSync(`${scratch}/.git`) ? buildCoGraph(scratch) : null;

    // build candidate universe = pool ∪ import-1hop(seeds) ∪ co-neighbours(seeds)
    const universe = new Set(poolPaths);
    for (const s of seeds) {
      for (const nb of adj.get(s) ?? []) universe.add(nb);
      if (co) for (const { file, jaccard } of co.neighbours(s)) if (jaccard >= CO_FLOOR) universe.add(file);
    }
    // connection score per candidate
    const conn = new Map<string, number>();
    for (const c of universe) {
      let impDeg = 0; for (const s of seeds) if (adj.get(s)?.has(c)) impDeg++;
      let coSum = 0; if (co) for (const s of seeds) coSum += co.jaccard(s, c);
      conn.set(c, impDeg + CO_W * coSum);
    }

    // (1) raw channel S/N: NEW files (in universe, not in baseline top-8, not a seed)
    const newFiles = [...universe].filter((c) => !baseTop8.has(c) && !seeds.includes(c) && (conn.get(c) ?? 0) > 0);
    const newGoldFiles = newFiles.filter(isGold);
    newTotal += newFiles.length; newGold += newGoldFiles.length;

    // (2) ranked expansion precision: rank NEW files by conn desc
    const ranked = newFiles.slice().sort((a, b) => (conn.get(b)! - conn.get(a)!));
    if (ranked.length) {
      expP.lists++;
      const goldAt = (k: number) => ranked.slice(0, k).filter(isGold).length;
      expP.at1 += goldAt(1) / 1; expP.at3 += goldAt(3) / 3; expP.at5 += goldAt(5) / 5;
      expP.recovered += newGoldFiles.length;
    }

    // (3) end-to-end re-rank
    const maxConn = Math.max(1e-9, ...[...universe].map((c) => conn.get(c) ?? 0));
    const goldRanksFor = (rk: string[]) => gold.map((gf) => { for (let i = 0; i < rk.length; i++) if (hit(rk[i], gf)) return i + 1; return 0; });
    let eeLine = "";
    GAMMAS.forEach((gamma, gi) => {
      const finalScore = (c: string) => (scoreOf.get(c) ?? 0) / maxPool + gamma * ((conn.get(c) ?? 0) / maxConn);
      const rk = [...universe].sort((a, b) => finalScore(b) - finalScore(a));
      const c8 = covPrec(rk, gold, 8), c12 = covPrec(rk, gold, 12);
      ee[gi].c8 += c8.cov; ee[gi].p8 += c8.prec; ee[gi].c12 += c12.cov; ee[gi].p12 += c12.prec;
      if (gamma === 0 || gamma === 0.6) eeLine += `  ${gamma === 0 ? "base" : "γ.6"}=[${goldRanksFor(rk).join(",")}]`;
    });
    perInst.push(`  ${g.dir.padEnd(20)} gold=${gold.length} newCand=${newFiles.length} newGold=${newGoldFiles.length}${eeLine}`);
    db.close();
  }

  const pc = (v: number, d = n) => (v / d * 100).toFixed(1) + "%";
  console.log(`Expansion precision, n=${n} multi-gold instances, seed=top-${SEED_K}\n`);
  console.log(`(1) raw channel S/N: ${newGold} gold among ${newTotal} new candidates = ${(newGold / newTotal * 100).toFixed(1)}% precision  (${(newTotal / Math.max(1, newGold)).toFixed(1)} noise per gold)`);
  console.log(`\n(2) ranked-expansion precision (NEW files ordered by connScore, ${expP.lists} instances):`);
  console.log(`    p@1=${pc(expP.at1, expP.lists)}  p@3=${pc(expP.at3, expP.lists)}  p@5=${pc(expP.at5, expP.lists)}   recovered ${expP.recovered} gold`);
  console.log(`\n(3) end-to-end re-rank over pool ∪ expansion:`);
  console.log(`    γ      cov@8   prec@8  cov@12  prec@12`);
  GAMMAS.forEach((gamma, gi) => {
    const a = ee[gi];
    console.log(`    ${String(gamma).padEnd(5)}  ${pc(a.c8).padStart(6)}  ${pc(a.p8).padStart(6)}  ${pc(a.c12).padStart(6)}  ${pc(a.p12).padStart(6)}`);
  });
  console.log(`\nper-instance (base vs γ.6 gold ranks; 0=miss):`);
  for (const l of perInst) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
