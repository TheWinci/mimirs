/**
 * ContextBench scorer on the cached cb-repos. Self-contained: reads the dataset
 * (raw issues + gold) and the blind distilled queries from repos/cb-repos/, scores
 * against each repo's own .mimirs index. No /tmp, no re-clone.
 *
 * Reports recorded methodology: file cov/prec @8 & @12 (from a 60-deep search
 * pool, sliced), line cov/prec from leaf chunks top-10. Modes: raw issue vs
 * blind distilled query.
 *
 * Run: bun benchmarks/contextbench/cb-score.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

async function main() {
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  dataset.sort((a, b) => a.dir.localeCompare(b.dir));
  const modes = ["raw", "distilled"] as const;
  const acc: Record<string, { c8: number; p8: number; c12: number; p12: number; lc: number; lp: number }> = {};
  for (const m of modes) acc[m] = { c8: 0, p8: 0, c12: 0, p12: 0, lc: 0, lp: 0 };
  const perInst: { dir: string; ranks: number[] }[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const goldFiles = [...new Set(g.gold.map((x) => x.file))];
    const goldLines = new Map<string, Set<number>>();
    for (const x of g.gold) { const s = goldLines.get(x.file) ?? new Set<number>(); for (let i = x.start; i <= x.end; i++) s.add(i); goldLines.set(x.file, s); }
    const totGold = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const qOf: Record<string, string> = { raw: g.problem_statement, distilled: queries[g.dir] ?? g.problem_statement };

    for (const m of modes) {
      const q = qOf[m];
      // 60-deep pool (search fetches topK*4 candidates), then slice fixed-8 / fixed-12.
      const ranked = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));
      const cp = (k: number) => {
        const pred = ranked.slice(0, k);
        const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length;
        return { cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0, prec: pred.length ? inter / pred.length : 0 };
      };
      const f8 = cp(8), f12 = cp(12);
      const chunks = await searchChunks(q, db, 10, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, cfg.leafOnly, false, cfg.chunkParentBoost, cfg.chunkRelCutoff, cfg.chunkSteepSkip);
      let predLines = 0, hitLines = 0; const goldHit = new Set<string>();
      for (const c of chunks) { if (c.startLine == null || c.endLine == null) continue; const rp = rel(c.path); const gl = goldLines.get(rp); for (let i = c.startLine; i <= c.endLine; i++) { predLines++; if (gl?.has(i)) { hitLines++; goldHit.add(`${rp}:${i}`); } } }
      const a = acc[m];
      a.c8 += f8.cov; a.p8 += f8.prec; a.c12 += f12.cov; a.p12 += f12.prec;
      a.lc += totGold ? goldHit.size / totGold : 0; a.lp += predLines ? hitLines / predLines : 0;
      if (m === "distilled") perInst.push({ dir: g.dir, ranks: goldFiles.map((gf) => { for (let i = 0; i < ranked.length; i++) if (hit(ranked[i], gf)) return i + 1; return 0; }) });
    }
    db.close();
  }

  const n = dataset.length;
  console.log(`ContextBench, n=${n}, current pipeline, product config (weight 0.5), tests excluded\n`);
  console.log(`mode       fileCov@8  filePrec@8  fileCov@12  filePrec@12   lineCov  linePrec`);
  for (const m of modes) {
    const a = acc[m]; const pct = (v: number) => (v / n * 100).toFixed(1).padStart(6) + "%";
    console.log(`${m.padEnd(9)}  ${pct(a.c8)}    ${pct(a.p8)}     ${pct(a.c12)}     ${pct(a.p12)}     ${pct(a.lc)}   ${pct(a.lp)}`);
  }
  console.log(`\nper-instance distilled gold ranks (0 = miss/excluded-test); in@8/@12:`);
  for (const p of perInst) {
    const i8 = p.ranks.filter((r) => r > 0 && r <= 8).length, i12 = p.ranks.filter((r) => r > 0 && r <= 12).length;
    console.log(`  ${p.dir.padEnd(20)} gold=${p.ranks.length} @8=${i8} @12=${i12}  ranks=[${p.ranks.join(",")}]`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
