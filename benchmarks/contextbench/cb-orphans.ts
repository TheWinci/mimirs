/**
 * Why does mimirs rank genuinely-irrelevant files high? Isolate the ORPHANS —
 * non-gold top-8 files NOT coupled to gold (import>2 hop AND co-change<.05) — and
 * attribute each to the pipeline channel that surfaced it, using the trace sink.
 *
 * For each orphan: its rank in the vector (semantic) list, the text (BM25) list,
 * whether symbol-expansion injected it, and whether the filename / graph boost
 * amplified it. That tells us the root cause: lexical false-friend vs semantic
 * drift vs boost over-fire vs symbol collision. The snippet is printed so we can
 * also judge whether the "orphan" is truly irrelevant or just a coupling-proxy miss.
 *
 * Same top-8 as the recorded table (search depth 60, sliced 8). Run:
 *   bun benchmarks/contextbench/cb-orphans.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, type SearchTrace } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const CO_FLOOR = 0.05;
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
function nodesFor(paths: string[], r: string): number[] { const o: number[] = []; paths.forEach((p, i) => { if (hit(p, r)) o.push(i); }); return o; }
function bfs(adj: number[][], sources: number[]): Int32Array {
  const dist = new Int32Array(adj.length).fill(-1); let fr = [...new Set(sources)];
  for (const s of fr) dist[s] = 0; let d = 0;
  while (fr.length) { const nx: number[] = []; for (const u of fr) for (const v of adj[u]) if (dist[v] === -1) { dist[v] = d + 1; nx.push(v); } fr = nx; d++; }
  return dist;
}

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;

  const cats: Record<string, number> = { "lexical (BM25 only)": 0, "semantic (vector only)": 0, "both channels": 0, "symbol-injected": 0 };
  let amplFn = 0, amplGraph = 0, total = 0;
  const examples: string[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`, scratch = `/tmp/cc-${g.dir}`;
    const db = new RagDB(dir); const cfg = await loadConfig(dir);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const isGold = (f: string) => gold.some((gf) => hit(f, gf));
    const { paths, adj } = buildImportGraph(db);
    const goldNodes = gold.flatMap((gf) => nodesFor(paths, gf));
    const dist = goldNodes.length ? bfs(adj, goldNodes) : null;
    const co = existsSync(`${scratch}/.git`) ? buildCoGraph(scratch) : null;
    const isRelevant = (f: string) => {
      if (isGold(f)) return true;
      if (dist) { const ns = nodesFor(paths, f); const dmin = ns.length ? Math.min(...ns.map((n) => dist[n]).filter((x) => x >= 0), Infinity) : Infinity; if (dmin <= 2) return true; }
      if (co && gold.some((gf) => co(gf, f) >= CO_FLOOR)) return true;
      return false;
    };

    const stages: { name: string; payload: any }[] = [];
    const trace: SearchTrace = { stage: (name, payload) => stages.push({ name, payload }) };
    await search(queries[g.dir] ?? g.problem_statement, db, 60, 0, cfg.hybridWeight, cfg.generated, undefined, trace);
    const S = (n: string) => stages.find((s) => s.name === n)?.payload;
    const ranked = (S("ranked") as any[]).map((r) => rel(r.path));
    const top8 = [...new Set(ranked)].slice(0, 8);

    const vec = S("vector") as any[], txt = S("text") as any[], sym = S("symbols") as { hits: string[] }, boosts = S("boosts") as any;
    const rankIn = (list: any[], relP: string) => { for (let i = 0; i < list.length; i++) if (rel(list[i].path) === relP) return i + 1; return 0; };
    const scoreIn = (list: any[], relP: string) => { for (const r of list) if (rel(r.path) === relP) return r.score as number; return null; };
    const snip = (relP: string) => { for (const r of vec) if (rel(r.path) === relP) return (r.snippet || "").replace(/\s+/g, " ").slice(0, 90); for (const r of txt) if (rel(r.path) === relP) return (r.snippet || "").replace(/\s+/g, " ").slice(0, 90); return ""; };

    for (const f of top8) {
      if (isGold(f) || isRelevant(f)) continue;
      total++;
      const vR = rankIn(vec, f), tR = rankIn(txt, f);
      const injected = (sym?.hits || []).some((h) => rel(h) === f);
      const pScore = scoreIn(boosts.path, f), fScore = scoreIn(boosts.filename, f), gScore = scoreIn(boosts.graph, f);
      const fnAmp = pScore != null && fScore != null && fScore > pScore + 1e-9;
      const grAmp = fScore != null && gScore != null && gScore > fScore + 1e-9;
      if (fnAmp) amplFn++; if (grAmp) amplGraph++;
      let cat: string;
      if (injected && vR === 0 && tR === 0) cat = "symbol-injected";
      else if (tR > 0 && (vR === 0 || tR < vR)) cat = "lexical (BM25 only)";
      else if (vR > 0 && tR === 0) cat = "semantic (vector only)";
      else cat = "both channels";
      cats[cat]++;
      examples.push(`  ${g.dir.padEnd(20)} ${f.split("/").slice(-2).join("/").padEnd(34)} v=${vR || "-"} t=${tR || "-"} ${injected ? "SYM " : ""}${fnAmp ? "+fn " : ""}${grAmp ? "+graph " : ""}[${cat.split(" ")[0]}]  «${snip(f)}»`);
    }
    db.close();
  }

  console.log(`Orphan analysis — non-gold top-8 NOT coupled to gold, n=15\n`);
  console.log(`total orphans: ${total}`);
  console.log(`\nroot-cause channel:`);
  for (const [k, v] of Object.entries(cats)) console.log(`  ${k.padEnd(24)} ${v}  (${total ? (v / total * 100).toFixed(0) : 0}%)`);
  console.log(`\namplified by boost: filename ${amplFn}/${total}, graph ${amplGraph}/${total}`);
  console.log(`\nper-orphan (v=vectorRank t=textRank, snippet to judge true-noise vs proxy-miss):`);
  for (const e of examples) console.log(e);
}
main().catch((e) => { console.error(e); process.exit(1); });
