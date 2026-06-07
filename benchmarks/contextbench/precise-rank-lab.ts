/**
 * Precise-rank lab: the oracle line precision ceiling is 64% (function granularity),
 * but mimirs scores ~15% because noise outranks gold — barrel files (__init__.py:
 * keyword-dense import lists) and test files sit above the gold chunks. Try clean
 * selection levers (drop tests, demote barrels) + shared-import expansion, sweep
 * topK, and check against EVERY agent's best metric. Run on the arena.
 * Run: bun benchmarks/contextbench/precise-rank-lab.ts
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

// agent best per metric (full-set, paper Table 2)
const AGENT = { fc: 0.733, fp: 0.709, lc: 0.318, lp: 0.376 };

type Span = { path: string; startLine: number; endLine: number };
function sc(spans: Span[]) {
  const pf = new Set<string>(); let pl = 0, ph = 0; const gh = new Set<string>();
  for (const c of spans) { const f = rel(c.path); pf.add(f); const gl = goldLines.get(f);
    for (let i = c.startLine; i <= c.endLine; i++) { pl++; if (gl?.has(i)) { ph++; gh.add(f + i); } } }
  const fc = [...goldFiles].filter((f) => pf.has(f)).length / goldFiles.size;
  const fp = pf.size ? [...pf].filter((f) => goldFiles.has(f)).length / pf.size : 0;
  const lc = tgl ? gh.size / tgl : 0; const lp = pl ? ph / pl : 0;
  return { fc, fp, lc, lp };
}
const isTest = (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_|_test\.|\.test\./.test(p) || /conftest/.test(p);
const isBarrel = (p: string) => { const b = p.split("/").pop()!; return b === "__init__.py" || b === "index.ts" || b === "index.js" || b === "mod.rs"; };

function win(r: ReturnType<typeof sc>) {
  const w = [r.fc > AGENT.fc, r.fp > AGENT.fp, r.lc > AGENT.lc, r.lp > AGENT.lp];
  return `${w.map((x, i) => (x ? "W" : ".")).join("")}`; // fc fp lc lp
}
const fmt = (r: ReturnType<typeof sc>) => `fc ${(r.fc*100).toFixed(0).padStart(3)}% fp ${(r.fp*100).toFixed(0).padStart(3)}% lc ${(r.lc*100).toFixed(0).padStart(3)}% lp ${(r.lp*100).toFixed(1).padStart(4)}%  win[${win(r)}]`;

async function main() {
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  const pool = await searchChunks(issue, db, 60, 0.0, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true);

  // clean + demote
  const cleaned = pool
    .filter((c) => c.startLine != null && c.endLine != null && !isTest(rel(c.path)))
    .map((c) => ({ ...c, score: isBarrel(rel(c.path)) ? c.score * 0.05 : c.score }))
    .sort((a, b) => b.score - a.score);

  // shared-import expansion (>=3) appended as tight spans
  const baseFiles = new Set(cleaned.map((c) => rel(c.path)));
  const impCount = new Map<string, number>();
  for (const f of [...baseFiles].slice(0, 12)) {
    const file = db.getFileByPath(repoDir + "/" + f); if (!file) continue;
    for (const d of db.getDependsOn(file.id)) { const dp = rel(d.path); if (!baseFiles.has(dp) && !isTest(dp)) impCount.set(dp, (impCount.get(dp) ?? 0) + 1); }
  }
  const expandSpans: Span[] = [];
  for (const [f, n] of impCount) { if (n < 3) continue;
    const ranges = db.getFileChunkRanges(repoDir + "/" + f).filter((r) => r.startLine != null && r.endLine != null);
    if (!ranges.length) continue; ranges.sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!));
    expandSpans.push({ path: repoDir + "/" + f, startLine: ranges[0].startLine!, endLine: ranges[0].endLine! });
  }

  console.log(`agent best to beat: fc 73% fp 71% lc 32% lp 38%   (win flags: fc fp lc lp)\n`);
  for (const K of [5, 8, 12, 20]) {
    const top: Span[] = cleaned.slice(0, K).map((c) => ({ path: c.path, startLine: c.startLine!, endLine: c.endLine! }));
    console.log(`top${String(K).padStart(2)}            ${fmt(sc(top))}`);
    console.log(`top${String(K).padStart(2)} +expand    ${fmt(sc([...top, ...expandSpans]))}`);
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
