/**
 * One-off experiment: does protected-head graph-recover help on cb-repos with the
 * RECOVERED original queries? Harness-local rerank (NO product change). Compares
 * baseline file ranking vs protected-head consensus-gated promote (head=5,
 * consensus 1 and 2). Reports fileCov/prec @8 & @12.
 *
 * Run: bun benchmarks/contextbench/cb-graph-recover.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

interface R { path: string; score: number }
/** protected-head, consensus-gated promote-only reorder (reorder-only, no new files) */
function recover(results: R[], db: RagDB, head: number, minSeeds: number, seedN = 10): R[] {
  if (head <= 0 || results.length <= head + 1) return results;
  const maxH = results[0]?.score || 1;
  const specCache = new Map<string, number>();
  const specOf = (p: string) => {
    let s = specCache.get(p);
    if (s == null) { const f = db.getFileByPath(p); s = 1 / Math.log2((f ? db.getImportersOf(f.id).length : 0) + 2); specCache.set(p, s); }
    return s;
  };
  const sig = new Map<string, number>(); const seedsOf = new Map<string, Set<number>>();
  results.slice(0, seedN).forEach((seed, si) => {
    const f = db.getFileByPath(seed.path); if (!f) return;
    const w = seed.score / maxH;
    for (const n of [...db.getDependsOn(f.id), ...db.getDependedOnBy(f.id)]) {
      sig.set(n.path, (sig.get(n.path) ?? 0) + w * specOf(n.path));
      (seedsOf.get(n.path) ?? seedsOf.set(n.path, new Set()).get(n.path)!).add(si);
    }
  });
  const headSet = new Set(results.slice(0, head).map((r) => r.path));
  const byPath = new Map(results.map((r) => [r.path, r]));
  const promote = [...sig.entries()]
    .filter(([p, v]) => v > 0 && !headSet.has(p) && (seedsOf.get(p)?.size ?? 0) >= minSeeds && byPath.has(p))
    .sort((a, b) => b[1] - a[1]).map(([p]) => byPath.get(p)!);
  if (!promote.length) return results;
  const ps = new Set(promote.map((r) => r.path));
  return [...results.slice(0, head), ...promote, ...results.slice(head).filter((r) => !ps.has(r.path))];
}

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const arms = [
    { label: "baseline", fn: (r: R[]) => r },
    { label: "recover h5 c1", fn: (r: R[], db: RagDB) => recover(r, db, 5, 1) },
    { label: "recover h5 c2", fn: (r: R[], db: RagDB) => recover(r, db, 5, 2) },
  ];
  const acc = arms.map(() => ({ c8: 0, p8: 0, c12: 0, p12: 0 }));
  const multi: { dir: string; base: number[]; c1: number[] }[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const goldFiles = [...new Set(g.gold.map((x) => x.file))];
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const pool = await search(queries[g.dir], db, 60, 0, cfg.hybridWeight, cfg.generated);
    const ranksOf = (rk: R[]) => goldFiles.map((gf) => { const rr = rk.map((x) => rel(x.path)); for (let i = 0; i < rr.length; i++) if (hit(rr[i], gf)) return i + 1; return 0; });
    arms.forEach((a, i) => {
      const rk = a.fn(pool.map((r) => ({ path: r.path, score: r.score })), db).map((r) => rel(r.path));
      const cp = (k: number) => { const pred = rk.slice(0, k); const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length; return { cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0, prec: pred.length ? inter / pred.length : 0 }; };
      const f8 = cp(8), f12 = cp(12); acc[i].c8 += f8.cov; acc[i].p8 += f8.prec; acc[i].c12 += f12.cov; acc[i].p12 += f12.prec;
    });
    if (goldFiles.length > 1) multi.push({ dir: g.dir, base: ranksOf(pool.map((r) => ({ path: r.path, score: r.score }))), c1: ranksOf(recover(pool.map((r) => ({ path: r.path, score: r.score })), db, 5, 1)) });
    db.close();
  }

  const n = dataset.length;
  console.log(`graph-recover on recovered originals, n=${n}\n`);
  console.log(`arm             fileCov@8  filePrec@8  fileCov@12  filePrec@12`);
  arms.forEach((a, i) => { const x = acc[i]; const pct = (v: number) => (v / n * 100).toFixed(1).padStart(6) + "%"; console.log(`${a.label.padEnd(14)}  ${pct(x.c8)}    ${pct(x.p8)}     ${pct(x.c12)}     ${pct(x.p12)}`); });
  console.log(`\nmulti-file instances — gold ranks baseline -> recover(h5 c1):`);
  for (const m of multi) console.log(`  ${m.dir.padEnd(20)} [${m.base.join(",")}] -> [${m.c1.join(",")}]`);
}
main().catch((e) => { console.error(e); process.exit(1); });
