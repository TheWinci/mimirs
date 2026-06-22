/**
 * cb-score + relevance annotation. Reproduces the recorded ContextBench numbers
 * EXACTLY (same pool, params, metrics as cb-score.ts), then layers a relevance
 * view: "relevant" = gold OR coupled-to-gold (import ≤2 hop / co-change ≥.05).
 *
 * Precision-vs-gold treats every non-gold file/line as wrong; but ~86% of those
 * are relevant context (cb-coupling.ts). So next to the recorded precision we
 * report relevance-precision (file @8/@12 + line), and the coupled share of the
 * non-gold fill. Coverage stays vs the edit-set (gold) — see the note printed
 * at the end and memory project_contextbench_wrong_metric.
 *
 * Run: bun benchmarks/contextbench/cb-relevance.ts
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

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
  const modes = ["raw", "distilled"] as const;
  // recorded (vs gold) + relevance (vs gold∪coupled)
  const acc: Record<string, { c8: number; p8: number; c12: number; p12: number; lc: number; lp: number; rp8: number; rp12: number; rlp: number; ng8: number; coup8: number }> = {};
  for (const m of modes) acc[m] = { c8: 0, p8: 0, c12: 0, p12: 0, lc: 0, lp: 0, rp8: 0, rp12: 0, rlp: 0, ng8: 0, coup8: 0 };
  let coAvail = 0;

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`, scratch = `/tmp/cc-${g.dir}`;
    const db = new RagDB(dir); const cfg = await loadConfig(dir);
    const goldFiles = [...new Set(g.gold.map((x) => x.file))];
    const goldLines = new Map<string, Set<number>>();
    for (const x of g.gold) { const s = goldLines.get(x.file) ?? new Set<number>(); for (let i = x.start; i <= x.end; i++) s.add(i); goldLines.set(x.file, s); }
    const totGold = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

    // coupling machinery
    const { paths, adj } = buildImportGraph(db);
    const goldNodes = goldFiles.flatMap((gf) => nodesFor(paths, gf));
    const dist = goldNodes.length ? bfs(adj, goldNodes) : null;
    const co = existsSync(`${scratch}/.git`) ? buildCoGraph(scratch) : null;
    if (co) coAvail++;
    const isGold = (f: string) => goldFiles.some((gf) => hit(f, gf));
    const isRelevant = (f: string) => {
      if (isGold(f)) return true;
      if (dist) { const ns = nodesFor(paths, f); const dmin = ns.length ? Math.min(...ns.map((n) => dist[n]).filter((x) => x >= 0), Infinity) : Infinity; if (dmin === 1 || dmin === 2) return true; }
      if (co && goldFiles.some((gf) => co(gf, f) >= CO_FLOOR)) return true;
      return false;
    };

    const qOf: Record<string, string> = { raw: g.problem_statement, distilled: queries[g.dir] ?? g.problem_statement };
    for (const m of modes) {
      const q = qOf[m];
      const ranked = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));
      // --- reproduce cb-score cp() exactly ---
      const cp = (k: number) => {
        const pred = ranked.slice(0, k);
        const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length;
        return { cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0, prec: pred.length ? inter / pred.length : 0 };
      };
      const f8 = cp(8), f12 = cp(12);
      // --- relevance precision (gold ∪ coupled) ---
      const relPrec = (k: number) => { const pred = ranked.slice(0, k); return pred.length ? pred.filter(isRelevant).length / pred.length : 0; };
      const pred8 = ranked.slice(0, 8);
      const ng8 = pred8.filter((f) => !isGold(f));
      // --- chunks: reproduce line metrics ---
      const chunks = await searchChunks(q, db, 10, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, cfg.leafOnly, false, cfg.chunkParentBoost, cfg.chunkRelCutoff, cfg.chunkSteepSkip);
      let predLines = 0, hitLines = 0, relLines = 0; const goldHit = new Set<string>();
      for (const c of chunks) {
        if (c.startLine == null || c.endLine == null) continue;
        const rp = rel(c.path); const span = c.endLine - c.startLine + 1;
        predLines += span;
        if (isRelevant(rp)) relLines += span;     // line is in a relevant file = relevant context
        const gl = goldLines.get(rp);
        for (let i = c.startLine; i <= c.endLine; i++) if (gl?.has(i)) { hitLines++; goldHit.add(`${rp}:${i}`); }
      }
      const a = acc[m];
      a.c8 += f8.cov; a.p8 += f8.prec; a.c12 += f12.cov; a.p12 += f12.prec;
      a.lc += totGold ? goldHit.size / totGold : 0; a.lp += predLines ? hitLines / predLines : 0;
      a.rp8 += relPrec(8); a.rp12 += relPrec(12); a.rlp += predLines ? relLines / predLines : 0;
      a.ng8 += ng8.length; a.coup8 += ng8.filter(isRelevant).length;
    }
    db.close();
  }

  const n = dataset.length;
  const pct = (v: number) => (v / n * 100).toFixed(1).padStart(6) + "%";
  console.log(`ContextBench, n=${n}, product config (weight 0.5), tests excluded\n`);
  console.log(`RECORDED (vs edit-set gold) — reproduces cb-score.ts:`);
  console.log(`mode       fileCov@8  filePrec@8  fileCov@12  filePrec@12   lineCov  linePrec`);
  for (const m of modes) { const a = acc[m]; console.log(`${m.padEnd(9)}  ${pct(a.c8)}    ${pct(a.p8)}     ${pct(a.c12)}     ${pct(a.p12)}     ${pct(a.lc)}   ${pct(a.lp)}`); }
  console.log(`\nRELEVANCE-ADJUSTED (relevant = gold ∪ coupled: import ≤2-hop OR co-change ≥${CO_FLOOR}; co-change on ${coAvail}/${n}):`);
  console.log(`mode       relFilePrec@8  relFilePrec@12  relLinePrec   coupledShare(non-gold@8)`);
  for (const m of modes) {
    const a = acc[m];
    const share = a.ng8 ? (a.coup8 / a.ng8 * 100).toFixed(0) + "%" : "—";
    console.log(`${m.padEnd(9)}  ${pct(a.rp8)}       ${pct(a.rp12)}       ${pct(a.rlp)}      ${share.padStart(5)}`);
  }
  console.log(`\nNOTE for the recorded table:`);
  console.log(`• Coverage (file & line) is vs the EDIT-set (gold patch). Correct as a floor:`);
  console.log(`  the must-edit code is a subset of relevant context, so surfacing it is necessary.`);
  console.log(`  fileCov@8 distilled = ${pct(acc.distilled.c8).trim()} stands as recorded — it answers "did we surface the code that changed".`);
  console.log(`• Precision (file & line) vs gold UNDERSTATES: it scores relevant context as wrong.`);
  console.log(`  filePrec@8 ${pct(acc.distilled.p8).trim()} → relFilePrec@8 ${pct(acc.distilled.rp8).trim()};  linePrec ${pct(acc.distilled.lp).trim()} → relLinePrec ${pct(acc.distilled.rlp).trim()}.`);
  console.log(`  The non-gold top-8 fill is ${acc.distilled.ng8 ? (acc.distilled.coup8 / acc.distilled.ng8 * 100).toFixed(0) : 0}% relevant context, not noise.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
