/**
 * mimirs cost side of the tool-vs-agent comparison. One retrieval call per issue.
 * Measures: file-search latency, read_relevant (content) latency + the context it
 * hands the agent (tokens ≈ chars/4), tool-calls = 1, retrieval API tokens = 0
 * (local embedder). Gold ranks from a deep pool show how many gold files arrive
 * in that single call. The agent baseline (cb-agent, spawned separately) gets the
 * raw issue and must grep/read to the same files — this is what it competes with.
 *
 * Run: bun benchmarks/contextbench/cb-cost.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);
const tok = (chars: number) => Math.round(chars / 4); // rough token estimate

async function main() {
  const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;

  const rows: { dir: string; goldN: number; at8: number; fileMs: number; chunkMs: number; ctxTok: number; ranks: number[] }[] = [];

  for (const g of dataset) {
    const dir = `${CB}/${g.dir}`;
    const db = new RagDB(dir); const cfg = await loadConfig(dir);
    const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const q = queries[g.dir] ?? g.problem_statement;

    // file search (deployment top=10) — latency
    const t0 = performance.now();
    await search(q, db, 10, 0, cfg.hybridWeight, cfg.generated);
    const fileMs = performance.now() - t0;

    // read_relevant (content the agent consumes) — latency + tokens
    const t1 = performance.now();
    const chunks = await searchChunks(q, db, 10, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, cfg.leafOnly, false, cfg.chunkParentBoost, cfg.chunkRelCutoff, cfg.chunkSteepSkip);
    const chunkMs = performance.now() - t1;
    const ctxTok = tok(chunks.reduce((a, c) => a + c.content.length, 0));

    // gold ranks from a deep pool (how many gold arrive in the single call)
    const deep = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));
    const ranks = gold.map((gf) => { for (let i = 0; i < deep.length; i++) if (hit(deep[i], gf)) return i + 1; return 0; });
    const at8 = ranks.filter((r) => r > 0 && r <= 8).length;

    rows.push({ dir: g.dir, goldN: gold.length, at8, fileMs, chunkMs, ctxTok, ranks });
    db.close();
  }

  console.log(`mimirs cost — one retrieval call per issue (retrieval API tokens = 0; local embedder)\n`);
  console.log(`instance              gold  @8  fileMs  rrMs  ctxTok  goldRanks`);
  let sFile = 0, sChunk = 0, sTok = 0, sGold = 0, sAt8 = 0;
  for (const r of rows) {
    console.log(`${r.dir.padEnd(20)}  ${String(r.goldN).padStart(3)}  ${String(r.at8).padStart(2)}  ${r.fileMs.toFixed(0).padStart(5)}  ${r.chunkMs.toFixed(0).padStart(4)}  ${String(r.ctxTok).padStart(6)}  [${r.ranks.join(",")}]`);
    sFile += r.fileMs; sChunk += r.chunkMs; sTok += r.ctxTok; sGold += r.goldN; sAt8 += r.at8;
  }
  const n = rows.length;
  console.log(`\nmean: fileMs ${(sFile / n).toFixed(0)}  rrMs ${(sChunk / n).toFixed(0)}  ctxTok ${(sTok / n).toFixed(0)}  toolCalls 1  retrievalApiTokens 0`);
  console.log(`gold coverage in the single call: ${sAt8}/${sGold} gold files in top-8 (${(sAt8 / sGold * 100).toFixed(0)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
