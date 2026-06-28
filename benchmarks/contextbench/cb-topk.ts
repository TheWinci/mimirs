/**
 * Tiny-K probe: distilled arm only. If an agent took just the top 1/2/3 files,
 * how do coverage + precision look? Answers "is the head trustworthy enough to
 * return only a handful of files." Also splits single-gold vs multi-gold, since
 * a tiny K can never cover a 5-gold fix.
 *
 * Run: bun benchmarks/contextbench/cb-topk.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

function covAtK(files: string[], gold: string[], k: number): number {
  const top = files.slice(0, k);
  return gold.length ? gold.filter((g) => top.some((f) => hit(f, g))).length / gold.length : 0;
}
function precAtK(files: string[], gold: string[], k: number): number {
  const top = files.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((f) => gold.some((g) => hit(f, g))).length / top.length;
}
// did top-k contain EVERY gold file (full recall for this instance)?
function fullCov(files: string[], gold: string[], k: number): boolean {
  const top = files.slice(0, k);
  return gold.every((g) => top.some((f) => hit(f, g)));
}

async function main() {
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  dataset.sort((a, b) => a.dir.localeCompare(b.dir));

  const Ks = [1, 2, 3, 8];
  const per: { dir: string; goldN: number; files: string[]; gold: string[] }[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const res = await search(queries[g.dir] ?? g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated);
    per.push({ dir: g.dir, goldN: gold.length, files: res.map((r) => rel(r.path)), gold });
    db.close();
  }

  const single = per.filter((p) => p.goldN === 1);
  const multi = per.filter((p) => p.goldN > 1);

  function report(label: string, rows: typeof per) {
    if (rows.length === 0) return;
    console.log(`\n${label} (n=${rows.length})`);
    console.log(`  K    fileCov   filePrec   fullCov%`);
    for (const k of Ks) {
      let c = 0, pr = 0, full = 0;
      for (const r of rows) { c += covAtK(r.files, r.gold, k); pr += precAtK(r.files, r.gold, k); if (fullCov(r.files, r.gold, k)) full++; }
      const n = rows.length;
      const pct = (v: number) => (v * 100).toFixed(1).padStart(6) + "%";
      console.log(`  ${String(k).padEnd(3)}  ${pct(c / n)}    ${pct(pr / n)}     ${pct(full / n)}`);
    }
  }

  console.log(`ContextBench tiny-K probe, distilled arm, n=${per.length}`);
  console.log(`single-gold=${single.length}  multi-gold=${multi.length}`);
  report("ALL", per);
  report("single-gold", single);
  report("multi-gold", multi);

  console.log(`\nper-instance gold ranks (distilled; 0=miss):`);
  for (const p of per) {
    const ranks = p.gold.map((g) => { for (let i = 0; i < p.files.length; i++) if (hit(p.files[i], g)) return i + 1; return 0; });
    console.log(`  ${p.dir.padEnd(20)} gold=${p.goldN}  ranks=[${ranks.join(",")}]`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
