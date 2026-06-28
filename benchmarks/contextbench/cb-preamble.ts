/**
 * Preamble (Arm A) confirm on real ContextBench gold. For a small/medium
 * multi-file subset, FRESH-index each repo twice (preamble off, then on) into
 * scratch DBs and score file + line metrics vs gold — clean A/B, no chunker
 * confound. Toggles process.env.RAG_PREAMBLE per phase (indexer reads it live).
 *
 * Run: bun benchmarks/contextbench/cb-preamble.ts
 */
import { readFileSync, rmSync, readdirSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { indexDirectory } from "../../src/indexing/indexer";
import { search, searchChunks } from "../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const GOLD = "/tmp/cb-gold";
const K = 10;
// default: ALL instances with gold. Pass dirs as args to restrict to a subset.
const SUBSET = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(GOLD).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

interface Gold { problem_statement: string; gold: { file: string; start: number; end: number }[] }
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

async function scoreInstance(dir: string, g: Gold) {
  const goldFiles = [...new Set(g.gold.map((x) => x.file))];
  const goldLines = new Map<string, Set<number>>();
  for (const x of g.gold) { const s = goldLines.get(x.file) ?? new Set<number>(); for (let i = x.start; i <= x.end; i++) s.add(i); goldLines.set(x.file, s); }
  const totalGold = [...goldLines.values()].reduce((a, s) => a + s.size, 0);

  const db = new RagDB(dir);
  const cfg = await loadConfig(dir);
  const pool = await search(g.problem_statement, db, 40, 0, cfg.hybridWeight, cfg.generated);
  const files = pool.map((r) => r.path);
  const top = files.slice(0, K);
  const fileCov = goldFiles.filter((f) => top.some((p) => hit(p, f))).length / goldFiles.length;
  let rank = 0; for (let i = 0; i < files.length; i++) if (goldFiles.some((f) => hit(files[i], f))) { rank = i + 1; break; }
  const mrr = rank ? 1 / rank : 0;

  const chunks = await searchChunks(g.problem_statement, db, 20, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount ?? 2, false);
  const goldHit = new Set<string>();
  for (const c of chunks) {
    if (c.startLine == null || c.endLine == null) continue;
    const rel = c.path.startsWith(dir) ? c.path.slice(dir.length + 1) : c.path;
    const gl = goldLines.get(rel); if (!gl) continue;
    for (let i = c.startLine; i <= c.endLine; i++) if (gl.has(i)) goldHit.add(`${rel}:${i}`);
  }
  const lineCov = totalGold ? goldHit.size / totalGold : 0;
  db.close();
  return { fileCov, mrr, lineCov };
}

async function main() {
  console.log(`Preamble CB confirm — ${SUBSET.length} instances, fresh-index off vs on\n`);
  const acc = { off: { fileCov: 0, mrr: 0, lineCov: 0 }, on: { fileCov: 0, mrr: 0, lineCov: 0 } };
  console.log(`instance              gFiles   off:fcov/lcov/mrr      on:fcov/lcov/mrr`);
  for (const d of SUBSET) {
    const g = JSON.parse(readFileSync(`${GOLD}/${d}.json`, "utf8")) as Gold;
    const src = `${CB}/${d}`;
    const res: Record<string, { fileCov: number; mrr: number; lineCov: number }> = {};
    for (const mode of ["off", "on"] as const) {
      process.env.RAG_PREAMBLE = mode === "on" ? "1" : "0";
      const dbDir = `/tmp/cbpre/${d}.${mode}`;
      process.env.RAG_DB_DIR = dbDir;
      rmSync(dbDir, { recursive: true, force: true });
      const db = new RagDB(src);
      const cfg = await loadConfig(src);
      await indexDirectory(src, db, cfg, () => {});
      db.close();
      res[mode] = await scoreInstance(src, g);
      for (const m of ["fileCov", "mrr", "lineCov"] as const) acc[mode][m] += res[mode][m];
    }
    const gf = [...new Set(g.gold.map((x) => x.file))].length;
    console.log(`${d.padEnd(20)}  ${String(gf).padStart(5)}    ${(res.off.fileCov*100).toFixed(0)}%/${(res.off.lineCov*100).toFixed(0)}%/${res.off.mrr.toFixed(2)}        ${(res.on.fileCov*100).toFixed(0)}%/${(res.on.lineCov*100).toFixed(0)}%/${res.on.mrr.toFixed(2)}`);
    // free the scratch indexes for this instance (big repos: ~100-350MB each)
    for (const mode of ["off", "on"]) rmSync(`/tmp/cbpre/${d}.${mode}`, { recursive: true, force: true });
  }
  const n = SUBSET.length;
  console.log(`\n=== mean over ${n} ===`);
  console.log(`mode   fileCov@${K}   lineCov   MRR`);
  for (const m of ["off", "on"] as const)
    console.log(`${m.padEnd(5)}  ${(acc[m].fileCov/n*100).toFixed(1).padStart(6)}%   ${(acc[m].lineCov/n*100).toFixed(1).padStart(5)}%   ${(acc[m].mrr/n).toFixed(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
