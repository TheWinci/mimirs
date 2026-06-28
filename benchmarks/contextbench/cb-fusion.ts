/**
 * Tier-0 multi-query fusion probe. Uses the TWO queries ContextBench already
 * ships per instance — raw problem_statement + blind distilled query — as a
 * 2-query proxy for the "produce N distilled queries and fuse" idea. Zero LLM
 * cost: no variant generation, just RRF over two result lists already available.
 *
 * Question it answers: does fusing a second phrasing pull gold files that the
 * single distilled query ranked too deep UP into top-k? If raw+distilled (a weak
 * pair — raw is noisy) already lifts gold, real diverse variants will lift more,
 * and Tier 1 (LLM variants) is worth building. If it does nothing, stop.
 *
 * Baseline = distilled-alone (the current production single-query path).
 *
 * Run: bun benchmarks/contextbench/cb-fusion.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, rrfFuse, type DedupedResult } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

/** rank of the first result matching expected gold file; 0 = not in list */
function rankOf(files: string[], gold: string): number {
  for (let i = 0; i < files.length; i++) if (hit(files[i], gold)) return i + 1;
  return 0;
}
function covAtK(files: string[], gold: string[], k: number): number {
  const top = files.slice(0, k);
  return gold.length ? gold.filter((g) => top.some((f) => hit(f, g))).length / gold.length : 0;
}

interface Agg { label: string; c8: number; c12: number }
function agg(label: string, per: { files: string[]; gold: string[] }[]): Agg {
  let c8 = 0, c12 = 0;
  for (const r of per) { c8 += covAtK(r.files, r.gold, 8); c12 += covAtK(r.files, r.gold, 12); }
  const n = per.length;
  return { label, c8: c8 / n, c12: c12 / n };
}

/** fuse two ranked DedupedResult lists by path, sort desc (rrfFuse leaves unsorted) */
function fuse(distilled: DedupedResult[], raw: DedupedResult[], weight: number): string[] {
  return rrfFuse(distilled, raw, weight, (r) => r.path)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.path);
}

async function main() {
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  dataset.sort((a, b) => a.dir.localeCompare(b.dir));

  const arms = {
    distilled: [] as { files: string[]; gold: string[] }[],
    raw: [] as { files: string[]; gold: string[] }[],
    "fuse@.5": [] as { files: string[]; gold: string[] }[],
    "fuse@.7": [] as { files: string[]; gold: string[] }[],
  };
  // recovered/lost tracking: per gold file, did fusion move it across the @8 line
  // relative to distilled-alone?
  let recovered8 = 0, lost8 = 0, recovered12 = 0, lost12 = 0;
  const perInst: { dir: string; goldN: number; dRanks: number[]; fRanks: number[] }[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

    const dRes = await search(queries[g.dir] ?? g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated);
    const rRes = await search(g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated);
    const dFiles = dRes.map((r) => rel(r.path));
    const rFiles = rRes.map((r) => rel(r.path));
    const f5 = fuse(dRes, rRes, 0.5).map(rel);
    const f7 = fuse(dRes, rRes, 0.7).map(rel);

    arms.distilled.push({ files: dFiles, gold });
    arms.raw.push({ files: rFiles, gold });
    arms["fuse@.5"].push({ files: f5, gold });
    arms["fuse@.7"].push({ files: f7, gold });

    // delta vs distilled, using the .7 arm (distilled-dominant — the safe default)
    const dRanks: number[] = [], fRanks: number[] = [];
    for (const gf of gold) {
      const dr = rankOf(dFiles, gf), fr = rankOf(f7, gf);
      dRanks.push(dr); fRanks.push(fr);
      const dIn8 = dr > 0 && dr <= 8, fIn8 = fr > 0 && fr <= 8;
      const dIn12 = dr > 0 && dr <= 12, fIn12 = fr > 0 && fr <= 12;
      if (!dIn8 && fIn8) recovered8++; if (dIn8 && !fIn8) lost8++;
      if (!dIn12 && fIn12) recovered12++; if (dIn12 && !fIn12) lost12++;
    }
    perInst.push({ dir: g.dir, goldN: gold.length, dRanks, fRanks });
    db.close();
  }

  console.log(`ContextBench Tier-0 fusion probe, n=${dataset.length}, weight=${"product"}\n`);
  console.log(`arm           fileCov@8  fileCov@12`);
  for (const a of [agg("distilled", arms.distilled), agg("raw", arms.raw), agg("fuse@.5", arms["fuse@.5"]), agg("fuse@.7", arms["fuse@.7"])]) {
    const pct = (v: number) => (v * 100).toFixed(1).padStart(6) + "%";
    console.log(`${a.label.padEnd(12)}  ${pct(a.c8)}     ${pct(a.c12)}`);
  }
  console.log(`\nfuse@.7 vs distilled gold-file crossings:`);
  console.log(`  into @8:  +${recovered8} recovered / -${lost8} lost   (net ${recovered8 - lost8})`);
  console.log(`  into @12: +${recovered12} recovered / -${lost12} lost   (net ${recovered12 - lost12})`);
  console.log(`\nper-instance gold ranks (d=distilled, f=fuse@.7; 0=miss):`);
  for (const p of perInst) {
    const moved = p.dRanks.map((dr, i) => dr !== p.fRanks[i]).some(Boolean) ? " *" : "";
    console.log(`  ${p.dir.padEnd(20)} gold=${p.goldN}  d=[${p.dRanks.join(",")}]  f=[${p.fRanks.join(",")}]${moved}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
