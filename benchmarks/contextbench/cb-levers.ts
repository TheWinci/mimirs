/**
 * Do this session's new levers help the REAL ContextBench? Tests the dual-vector
 * LOCATOR layer: index each instance once with RAG_CTXVEC=locator (body vector is
 * byte-identical to baseline — embedText returns pure c.text; only vec_chunks_ctx
 * gains a second vector), then score the SAME index twice — ctx-fusion OFF (true
 * baseline) vs ON (search reads RAG_CTXVEC at query time). One index per instance.
 *
 * Scores file-coverage@K + MRR vs dataset.json gold, using queries.json.
 *
 * Run: bun benchmarks/contextbench/cb-levers.ts [dir1,dir2,...]
 */
import { readFileSync, rmSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const K = 10;
interface Inst { dir: string; problem_statement: string; gold: { file: string }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

async function scoreOn(db: RagDB, cfg: { hybridWeight: number; generated: string[] }, dir: string, q: string, gold: string[]) {
  const res = await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated);
  const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
  const files = res.map((r) => rel(r.path));
  const top = files.slice(0, K);
  const fileCov = gold.filter((g) => top.some((f) => hit(f, g))).length / gold.length;
  let rank = 0; for (let i = 0; i < files.length; i++) if (gold.some((g) => hit(files[i], g))) { rank = i + 1; break; }
  const full = gold.every((g) => top.some((f) => hit(f, g)));
  return { fileCov, mrr: rank ? 1 / rank : 0, full: full ? 1 : 0 };
}

async function main() {
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const only = process.argv[2]?.split(",");
  const insts = (only ? dataset.filter((d) => only.includes(d.dir)) : dataset).sort((a, b) => a.dir.localeCompare(b.dir));

  const acc = { off: { fileCov: 0, mrr: 0, full: 0 }, loc: { fileCov: 0, mrr: 0, full: 0 } };
  console.log(`ContextBench lever test — dual-vector LOCATOR, ${insts.length} instances\n`);
  console.log(`instance              gold   off:fcov/mrr/full     loc:fcov/mrr/full`);
  for (const g of insts) {
    const src = `${CB}/${g.dir}`;
    const gold = [...new Set(g.gold.map((x) => x.file))];
    const q = queries[g.dir] ?? g.problem_statement;
    const dbDir = `/tmp/cb-levers/${g.dir}`;
    process.env.RAG_DB_DIR = dbDir;
    const t = performance.now();
    const lexical = process.env.LEVER === "lexical";
    let off: { fileCov: number; mrr: number; full: number }, loc: typeof off;
    if (lexical) {
      // parts column is baked at index time → two separate indexes (off / on).
      delete process.env.RAG_LEXICAL_ENTITY;
      rmSync(dbDir, { recursive: true, force: true });
      let db = new RagDB(src); const cfg = await loadConfig(src);
      await indexDirectory(src, db, cfg, () => {});
      off = await scoreOn(db, cfg, src, q, gold); db.close();
      process.env.RAG_LEXICAL_ENTITY = "1";
      rmSync(dbDir, { recursive: true, force: true });
      db = new RagDB(src);
      await indexDirectory(src, db, cfg, () => {});
      loc = await scoreOn(db, cfg, src, q, gold); db.close();
      delete process.env.RAG_LEXICAL_ENTITY;
    } else {
      process.env.RAG_CTXVEC = "locator";   // index-time: build the ctx (locator) vector
      rmSync(dbDir, { recursive: true, force: true });
      const db = new RagDB(src);
      const cfg = await loadConfig(src);
      await indexDirectory(src, db, cfg, () => {});
      delete process.env.RAG_CTXVEC;          // search baseline: body vector only
      off = await scoreOn(db, cfg, src, q, gold);
      process.env.RAG_CTXVEC = "locator";     // search dual: fuse ctx vector
      loc = await scoreOn(db, cfg, src, q, gold);
      db.close();
    }
    rmSync(dbDir, { recursive: true, force: true });

    for (const m of ["fileCov", "mrr", "full"] as const) { acc.off[m] += off[m]; acc.loc[m] += loc[m]; }
    const fmt = (r: typeof off) => `${(r.fileCov * 100).toFixed(0)}%/${r.mrr.toFixed(2)}/${r.full}`;
    console.log(`${g.dir.padEnd(20)}  ${String(gold.length).padStart(4)}   ${fmt(off).padEnd(18)}   ${fmt(loc)}   (${((performance.now() - t) / 1000).toFixed(0)}s)`);
  }
  delete process.env.RAG_CTXVEC;
  const n = insts.length;
  console.log(`\n=== mean over ${n} ===`);
  console.log(`mode   fileCov@${K}   MRR     fullCov%`);
  for (const m of ["off", "loc"] as const)
    console.log(`${m.padEnd(5)}  ${(acc[m].fileCov / n * 100).toFixed(1).padStart(6)}%   ${(acc[m].mrr / n).toFixed(3)}   ${(acc[m].full / n * 100).toFixed(1)}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
