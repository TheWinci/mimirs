/**
 * Reachability audit (oracle, NOT a reranker). Premise: tiny-K returns a
 * confident seed of found-gold files. Question: are the MISSING gold files
 * (deep secondaries that tiny-K drops) connected to the found gold — through
 * the import graph or git co-change — so an expansion step COULD recover them?
 *
 * This measures whether the connection EXISTS (upper bound on recovery), not
 * whether a ranker exploits it. If missing gold is unreachable from found gold,
 * graph expansion is a dead end and we stop. If reachable, it tells us which
 * channel (imports vs co-change) is the vehicle.
 *
 * Two seedings:
 *   (A) gold→gold : seed = gold found in top-3. Is missing gold related to it?
 *   (B) realistic : seed = the top-3 RETRIEVED files (gold + noise). Does
 *                   expanding them (1-hop import ∪ co-change) cover missing gold?
 *
 * Channels: undirected import graph (db.getGraph) BFS distance; co-change
 * jaccard from leak-safe /tmp/cc-<dir> git history (same source as cb-cochange).
 *
 * Run: bun benchmarks/contextbench/cb-reach.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);
const SEED_K = 3;
const CO_FLOOR = 0.05;

const MULTI = new Set(["astropy-deb49033", "matplotlib-bebfd692", "pylint-da598baa", "pylint-1409977d", "requests-e989ba2d", "xarray-42c77239", "xarray-90532e38"]);

// ── co-change graph from leak-safe scratch git (mirrors cb-cochange) ──
function buildCoGraph(gitDir: string, maxCommitFiles = 25) {
  const out = execFileSync("git", ["-C", gitDir, "log", "HEAD", "--no-merges", "--name-only", "--pretty=format:@@@%H"], { maxBuffer: 1 << 30 }).toString();
  const commits: string[][] = [];
  let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@@")) { if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur); cur = []; }
    else if (line.trim()) cur?.push(line.trim());
  }
  if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur);
  const count = new Map<string, number>();
  const idx = new Map<string, number[]>();
  commits.forEach((files, i) => { for (const f of new Set(files)) { count.set(f, (count.get(f) ?? 0) + 1); (idx.get(f) ?? idx.set(f, []).get(f)!).push(i); } });
  const jaccard = (a: string, b: string): number => {
    const ia = idx.get(a); if (!ia) return 0;
    const setB = new Set(idx.get(b) ?? []);
    let t = 0; for (const i of ia) if (setB.has(i)) t++;
    if (!t) return 0;
    const ca = count.get(a) ?? 0, cb = count.get(b) ?? 0;
    return t / (ca + cb - t);
  };
  return { jaccard };
}

// ── undirected import graph: BFS distances over node indices ──
function buildImportGraph(db: RagDB) {
  const g = db.getGraph();
  const paths: string[] = g.nodes.map((n: any) => n.path);
  const idx = new Map<string, number>();
  paths.forEach((p, i) => idx.set(p, i));
  const adj: number[][] = paths.map(() => []);
  for (const e of g.edges as any[]) {
    const a = idx.get(e.fromPath), b = idx.get(e.toPath);
    if (a == null || b == null || a === b) continue;
    adj[a].push(b); adj[b].push(a);
  }
  return { paths, adj };
}
// node indices whose path matches a repo-relative gold/file
function nodesFor(paths: string[], rel: string): number[] {
  const out: number[] = [];
  paths.forEach((p, i) => { if (hit(p, rel)) out.push(i); });
  return out;
}
// multi-source BFS: min distance from any source set to every node
function bfs(adj: number[][], sources: number[]): Int32Array {
  const dist = new Int32Array(adj.length).fill(-1);
  let frontier = [...new Set(sources)];
  for (const s of frontier) dist[s] = 0;
  let d = 0;
  while (frontier.length) {
    const next: number[] = [];
    for (const u of frontier) for (const v of adj[u]) if (dist[v] === -1) { dist[v] = d + 1; next.push(v); }
    frontier = next; d++;
  }
  return dist;
}

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).filter((g) => MULTI.has(g.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;

  // aggregate counters over all MISSING gold files (gold not in top-3)
  let missTotal = 0;
  const A = { imp1: 0, imp2: 0, imp3plus: 0, impNever: 0, notInGraph: 0, co: 0, coOrImp2: 0 }; // gold→gold
  const B = { covered1hop: 0, coveredCo: 0, coveredUnion: 0 };                                   // realistic top-3 expand

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const scratch = `/tmp/cc-${g.dir}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const gold = [...new Set(g.gold.map((x) => x.file))];

    const ranked = (await search(queries[g.dir] ?? g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));
    const top3 = ranked.slice(0, SEED_K);
    const foundGold = gold.filter((gf) => top3.some((f) => hit(f, gf)));
    const missGold = gold.filter((gf) => !top3.some((f) => hit(f, gf)));

    const { paths, adj } = buildImportGraph(db);
    const co = existsSync(`${scratch}/.git`) ? buildCoGraph(scratch) : null;

    // (A) gold→gold: BFS from FOUND-gold nodes
    const foundGoldNodes = foundGold.flatMap((gf) => nodesFor(paths, gf));
    const distFromFoundGold = foundGoldNodes.length ? bfs(adj, foundGoldNodes) : null;

    // (B) realistic: 1-hop import neighbours of top-3 retrieved + co-change neighbours of top-3
    const top3Nodes = top3.flatMap((f) => nodesFor(paths, f));
    const reach1 = new Set<number>();
    for (const u of top3Nodes) for (const v of adj[u]) reach1.add(v);
    const reachByImport = (gf: string) => nodesFor(paths, gf).some((n) => reach1.has(n));
    const reachByCo = (gf: string) => co ? top3.some((s) => co.jaccard(s, gf) >= CO_FLOOR) : false;

    const detail: string[] = [];
    for (const gf of missGold) {
      missTotal++;
      // (A)
      const gNodes = nodesFor(paths, gf);
      let tag = "";
      if (gNodes.length === 0) { A.notInGraph++; tag = "graph✗"; }
      else if (!distFromFoundGold) { A.impNever++; tag = "noFoundGoldNode"; }
      else {
        const dmin = Math.min(...gNodes.map((n) => distFromFoundGold[n]).filter((d) => d >= 0), Infinity);
        if (dmin === 1) { A.imp1++; tag = "imp=1"; }
        else if (dmin === 2) { A.imp2++; tag = "imp=2"; }
        else if (dmin !== Infinity) { A.imp3plus++; tag = `imp=${dmin}`; }
        else { A.impNever++; tag = "imp=∞"; }
      }
      // co-change to any FOUND gold
      const bestJac = co ? Math.max(0, ...foundGold.map((s) => co.jaccard(s, gf))) : 0;
      const coHit = bestJac >= CO_FLOOR;
      if (coHit) A.co++;
      if (coHit || tag === "imp=1" || tag === "imp=2") A.coOrImp2++;
      // (B)
      const bImp = reachByImport(gf), bCo = reachByCo(gf);
      if (bImp) B.covered1hop++;
      if (bCo) B.coveredCo++;
      if (bImp || bCo) B.coveredUnion++;
      detail.push(`${gf.split("/").pop()}: A[${tag}${coHit ? `,co=${bestJac.toFixed(2)}` : ""}] B[${bImp ? "imp1hop " : ""}${bCo ? "co" : ""}${!bImp && !bCo ? "—" : ""}]`);
    }
    console.log(`${g.dir}  gold=${gold.length} found@3=${foundGold.length} missing=${missGold.length}  graph(${paths.length}n)`);
    for (const d of detail) console.log(`    ${d}`);
    db.close();
  }

  const pct = (v: number) => `${v}/${missTotal} (${(v / missTotal * 100).toFixed(0)}%)`;
  console.log(`\n=== ${missTotal} missing gold files across 7 multi-gold instances ===`);
  console.log(`(A) relation to FOUND gold:`);
  console.log(`   import 1-hop : ${pct(A.imp1)}`);
  console.log(`   import 2-hop : ${pct(A.imp2)}`);
  console.log(`   import 3+    : ${pct(A.imp3plus)}`);
  console.log(`   import ∞     : ${pct(A.impNever)}`);
  console.log(`   not in graph : ${pct(A.notInGraph)}`);
  console.log(`   co-change≥${CO_FLOOR} : ${pct(A.co)}`);
  console.log(`   co OR imp≤2  : ${pct(A.coOrImp2)}   <-- recoverable upper bound`);
  console.log(`(B) recovered by expanding top-3 RETRIEVED (realistic):`);
  console.log(`   import 1-hop : ${pct(B.covered1hop)}`);
  console.log(`   co-change    : ${pct(B.coveredCo)}`);
  console.log(`   union        : ${pct(B.coveredUnion)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
