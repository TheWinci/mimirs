/**
 * Is the "precision miss" actually noise? For every NON-gold file mimirs ranks
 * in top-8, classify it: is it coupled to a gold file (import-neighbour or
 * co-change partner = plausibly relevant context) or an orphan (= true noise)?
 *
 * If most non-gold top-8 is coupled, filePrec@gold is penalizing mimirs for
 * surfacing relevant context — the metric's denominator is wrong (see
 * memory project_contextbench_wrong_metric). If mostly orphan, precision still
 * means something.
 *
 * Import graph for all 15; co-change only where leak-safe /tmp/cc-* exists
 * (the 7 multi-gold). distilled query, top-8 (the precision-bias window).
 *
 * Run: bun benchmarks/contextbench/cb-coupling.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const K = 8, CO_FLOOR = 0.05;
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

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
  return (a: string, b: string): number => {
    const ia = idx.get(a); if (!ia) return 0; const setB = new Set(idx.get(b) ?? []);
    let t = 0; for (const i of ia) if (setB.has(i)) t++; if (!t) return 0;
    return t / ((count.get(a) ?? 0) + (count.get(b) ?? 0) - t);
  };
}

function buildImportGraph(db: RagDB) {
  const g = db.getGraph();
  const paths: string[] = g.nodes.map((n: any) => n.path);
  const idx = new Map<string, number>(); paths.forEach((p, i) => idx.set(p, i));
  const adj: number[][] = paths.map(() => []);
  for (const e of g.edges as any[]) { const a = idx.get(e.fromPath), b = idx.get(e.toPath); if (a == null || b == null || a === b) continue; adj[a].push(b); adj[b].push(a); }
  return { paths, adj };
}
function nodesFor(paths: string[], rel: string): number[] { const o: number[] = []; paths.forEach((p, i) => { if (hit(p, rel)) o.push(i); }); return o; }
function bfs(adj: number[][], sources: number[]): Int32Array {
  const dist = new Int32Array(adj.length).fill(-1); let fr = [...new Set(sources)];
  for (const s of fr) dist[s] = 0; let d = 0;
  while (fr.length) { const nx: number[] = []; for (const u of fr) for (const v of adj[u]) if (dist[v] === -1) { dist[v] = d + 1; nx.push(v); } fr = nx; d++; }
  return dist;
}

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;

  let goldHits = 0, nonGold = 0;
  const C = { imp1: 0, imp2: 0, co: 0, coupled: 0, orphanInGraph: 0, notInGraph: 0 };
  let coAvail = 0;
  const lines: string[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`, scratch = `/tmp/cc-${g.dir}`;
    const db = new RagDB(dir); const cfg = await loadConfig(dir);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const top = (await search(queries[g.dir] ?? g.problem_statement, db, K, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));

    const { paths, adj } = buildImportGraph(db);
    const goldNodes = gold.flatMap((gf) => nodesFor(paths, gf));
    const dist = goldNodes.length ? bfs(adj, goldNodes) : null;
    const co = existsSync(`${scratch}/.git`) ? buildCoGraph(scratch) : null;
    if (co) coAvail++;

    let g8 = 0; const tags: string[] = [];
    for (const f of top) {
      if (gold.some((gf) => hit(f, gf))) { goldHits++; g8++; tags.push("G"); continue; }
      nonGold++;
      const fNodes = nodesFor(paths, f);
      const dmin = dist && fNodes.length ? Math.min(...fNodes.map((n) => dist[n]).filter((x) => x >= 0), Infinity) : Infinity;
      const coBest = co ? Math.max(0, ...gold.map((gf) => co(gf, f))) : 0;
      const impCoupled = dmin === 1 || dmin === 2;
      const coCoupled = coBest >= CO_FLOOR;
      if (dmin === 1) C.imp1++; else if (dmin === 2) C.imp2++;
      if (coCoupled) C.co++;
      if (impCoupled || coCoupled) { C.coupled++; tags.push(dmin === 1 ? "i1" : dmin === 2 ? "i2" : "co"); }
      else if (fNodes.length === 0) { C.notInGraph++; tags.push("?"); }
      else { C.orphanInGraph++; tags.push("x"); }
    }
    lines.push(`  ${g.dir.padEnd(20)} gold@8=${g8}/${gold.length} top8=[${tags.join(" ")}]${co ? "" : "  (no co)"}`);
    db.close();
  }

  const pc = (v: number) => `${v}/${nonGold} (${(v / nonGold * 100).toFixed(0)}%)`;
  console.log(`Coupling of non-gold top-${K} to gold, n=${dataset.length} (co-change avail: ${coAvail}/${dataset.length})\n`);
  console.log(`top-8 composition: ${goldHits} gold + ${nonGold} non-gold = ${goldHits + nonGold} slots`);
  console.log(`\nnon-gold classification:`);
  console.log(`  import 1-hop to gold : ${pc(C.imp1)}`);
  console.log(`  import 2-hop to gold : ${pc(C.imp2)}`);
  console.log(`  co-change to gold    : ${pc(C.co)}`);
  console.log(`  COUPLED (relevant)   : ${pc(C.coupled)}   <-- precision metric counts these as misses`);
  console.log(`  orphan (in graph)    : ${pc(C.orphanInGraph)}`);
  console.log(`  not in graph / no-co : ${pc(C.notInGraph)}`);
  console.log(`\nlegend: G=gold i1/i2=import-hop co=co-change x=orphan ?=unclassifiable`);
  for (const l of lines) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
