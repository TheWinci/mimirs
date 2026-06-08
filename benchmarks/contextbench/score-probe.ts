/**
 * Scoring-diagnostic probe (fast, deterministic, no agents/re-clone). For the
 * arena issue query: rank-ordered chunks with score + gold/barrel/test flags,
 * precision/coverage at K, and "how much noise outranks the first gold chunk".
 * The iteration loop for scoring fixes in searchChunks. Run:
 *   bun benchmarks/contextbench/score-probe.ts [topShow]
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks, type ChunkResult } from "../../src/search/hybrid";

const repoDir = "/tmp/cb-arena/repo";
const issue = readFileSync("/tmp/cb-arena/issue.txt", "utf8");
const gold = (JSON.parse(readFileSync("/tmp/cb-arena-gold.json", "utf8")).gold) as { file: string; start: number; end: number }[];
const goldFiles = new Set(gold.map((g) => g.file));
const goldLines = new Map<string, Set<number>>();
for (const g of gold) { const s = goldLines.get(g.file) ?? new Set<number>(); for (let i = g.start; i <= g.end; i++) s.add(i); goldLines.set(g.file, s); }
const tgl = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
const rel = (p: string) => !p ? "" : (p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p);
const base = (p: string) => rel(p).split("/").pop() ?? "";
const isBarrel = (p: string) => ["__init__.py", "index.ts", "index.js", "mod.rs"].includes(base(p));
const isTest = (p: string) => /(^|\/)tests?\//.test(rel(p)) || /test_|_test\.|\.test\./.test(base(p)) || base(p) === "conftest.py";
const goldOverlap = (c: ChunkResult) => {
  if (c.startLine == null || c.endLine == null) return 0;
  const gl = goldLines.get(rel(c.path)); if (!gl) return 0;
  let n = 0; for (let i = c.startLine; i <= c.endLine; i++) if (gl.has(i)) n++; return n;
};

function metricsAt(chunks: ChunkResult[], K: number) {
  const top = chunks.slice(0, K);
  const pf = new Set<string>(); let pl = 0, ph = 0; const gh = new Set<string>();
  for (const c of top) {
    if (c.startLine == null || c.endLine == null) continue;
    const f = rel(c.path); pf.add(f); const gl = goldLines.get(f);
    for (let i = c.startLine; i <= c.endLine; i++) { pl++; if (gl?.has(i)) { ph++; gh.add(f + i); } }
  }
  const fileCov = [...goldFiles].filter((f) => pf.has(f)).length / goldFiles.size;
  const filePrec = pf.size ? [...pf].filter((f) => goldFiles.has(f)).length / pf.size : 0;
  const lineCov = tgl ? gh.size / tgl : 0; const linePrec = pl ? ph / pl : 0;
  return { fileCov, filePrec, lineCov, linePrec };
}

async function main() {
  const topShow = parseInt(process.argv[2] ?? "20", 10);
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  // cb-adapter (the real benchmark) excludes tests at index time, so filter them
  // from candidates here to keep this probe a faithful proxy.
  const raw = await searchChunks(issue, db, 60, 0, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true, process.env.SYMEXPAND==="1");
  const res = raw.filter((c) => !isTest(c.path)).slice(0, 40);

  console.log(`ARENA deb49033 — gold ${gold.length} spans / ${goldFiles.size} files / ${tgl} lines\n`);
  console.log(`rank  score   tag    file:lines`);
  let firstGoldRank = -1, noiseAboveGold = 0;
  res.slice(0, topShow).forEach((c, i) => {
    const g = goldOverlap(c);
    const tag = g > 0 ? `GOLD` : isBarrel(c.path) ? `barrel` : isTest(c.path) ? `test` : "-";
    if (g > 0 && firstGoldRank < 0) firstGoldRank = i + 1;
    if (g === 0 && firstGoldRank < 0 && (isBarrel(c.path) || isTest(c.path))) noiseAboveGold++;
    console.log(`${String(i + 1).padStart(3)}  ${c.score.toFixed(3).padStart(7)}  ${tag.padEnd(6)} ${rel(c.path)}:${c.startLine}-${c.endLine}`);
  });

  console.log(`\nfirst gold at rank ${firstGoldRank}; barrels/tests above it: ${noiseAboveGold}`);
  console.log(`\nK    fileCov filePrec lineCov linePrec`);
  for (const K of [8, 12, 20]) {
    const m = metricsAt(res, K);
    console.log(`${String(K).padStart(2)}    ${(m.fileCov*100).toFixed(0).padStart(4)}%   ${(m.filePrec*100).toFixed(0).padStart(4)}%  ${(m.lineCov*100).toFixed(0).padStart(4)}%   ${(m.linePrec*100).toFixed(1).padStart(5)}%`);
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
