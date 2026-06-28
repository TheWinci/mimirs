/**
 * ContextBench confirm of the doc2query lever (the real-repo gate). For each
 * instance: index ONCE with RAG_CTXVEC=blurb + RAG_CTXVEC_BLURB_FILE pointed at a
 * doc2query map (keyed by content_hash) — body vector is byte-identical to baseline,
 * only vec_chunks_ctx gains a doc2query vector. Then score the SAME index twice with
 * the full hybrid pipeline + distilled queries: ctx-fusion OFF (baseline) vs ON
 * (search folds the doc2query vector by max). fileCov@10 + MRR + fullCov vs gold.
 *
 * doc2query map must cover the chunks of the instances passed (see scratchpad
 * cb-doc2query.json). Run:
 *   RAG_CTXVEC_BLURB_FILE=.cb-anthropic/cb-doc2query.json \
 *     bun benchmarks/contextbench/cb-d2q-confirm.ts requests-e989ba2d flask-2e76c8cd xarray-90532e38
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
  if (!process.env.RAG_CTXVEC_BLURB_FILE) { console.error("set RAG_CTXVEC_BLURB_FILE to the doc2query map"); process.exit(1); }
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  // CB_QUERY_FILE -> {dir: query} override (e.g. a weak-model-distilled set) to test
  // whether doc2query lifts a weaker query toward the strong-distilled baseline.
  const queries = process.env.CB_QUERY_FILE
    ? JSON.parse(readFileSync(process.env.CB_QUERY_FILE, "utf8")) as Record<string, string>
    : JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  const only = process.argv.slice(2);
  const insts = dataset.filter((d) => only.includes(d.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
  if (!insts.length) { console.error("no matching instances"); process.exit(1); }

  const acc = { off: { fileCov: 0, mrr: 0, full: 0 }, d2q: { fileCov: 0, mrr: 0, full: 0 } };
  console.log(`ContextBench doc2query confirm — ${insts.length} instances, blurb=${process.env.RAG_CTXVEC_BLURB_FILE}\n`);
  console.log(`instance              gold   off:fcov/mrr/full     d2q:fcov/mrr/full`);
  for (const g of insts) {
    const src = `${CB}/${g.dir}`;
    const gold = [...new Set(g.gold.map((x) => x.file))];
    // CB_RAW=1 -> use the raw problem_statement (the WEAK query floor) instead of the
    // strong best-model distilled query, to test whether doc2query lifts weak queries.
    const q = process.env.CB_RAW ? g.problem_statement : (queries[g.dir] ?? g.problem_statement);
    const dbDir = `/tmp/cb-d2q/${g.dir}`;
    process.env.RAG_DB_DIR = dbDir;
    const t = performance.now();

    process.env.RAG_CTXVEC = "blurb";          // index-time: build the doc2query ctx vector
    rmSync(dbDir, { recursive: true, force: true });
    const db = new RagDB(src);
    const cfg = await loadConfig(src);
    await indexDirectory(src, db, cfg, () => {});
    delete process.env.RAG_CTXVEC;              // search baseline: body vector only
    const off = await scoreOn(db, cfg, src, q, gold);
    process.env.RAG_CTXVEC = "blurb";          // search dual: fuse doc2query vector by max
    const d2q = await scoreOn(db, cfg, src, q, gold);
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    delete process.env.RAG_CTXVEC;

    for (const m of ["fileCov", "mrr", "full"] as const) { acc.off[m] += off[m]; acc.d2q[m] += d2q[m]; }
    const fmt = (r: typeof off) => `${(r.fileCov * 100).toFixed(0)}%/${r.mrr.toFixed(2)}/${r.full}`;
    console.log(`${g.dir.padEnd(20)}  ${String(gold.length).padStart(4)}   ${fmt(off).padEnd(18)}   ${fmt(d2q)}   (${((performance.now() - t) / 1000).toFixed(0)}s)`);
  }
  const n = insts.length;
  console.log(`\n=== mean over ${n} ===`);
  console.log(`mode   fileCov@${K}   MRR     fullCov%`);
  for (const m of ["off", "d2q"] as const)
    console.log(`${m.padEnd(5)}  ${(acc[m].fileCov / n * 100).toFixed(1).padStart(6)}%   ${(acc[m].mrr / n).toFixed(3)}   ${(acc[m].full / n * 100).toFixed(1)}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
