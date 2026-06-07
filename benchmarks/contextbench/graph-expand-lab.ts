/**
 * Graph-expansion lab: pure semantic retrieval misses gold files that the fix
 * needs but that aren't semantically similar to the issue (e.g. imported helpers).
 * mimirs has the import graph — so after retrieving, pull the best chunk from
 * files IMPORTED by the top hits (gated by relevance) to recover those gold files.
 * Scores all ContextBench metrics on the arena, no agents/re-clone.
 *
 * Run: bun benchmarks/contextbench/graph-expand-lab.ts
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
const totalGoldLines = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
const rel = (p: string) => p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p;

function score(chunks: ChunkResult[]) {
  const pf = new Set<string>(); let pl = 0, ph = 0; const gh = new Set<string>();
  for (const c of chunks) {
    if (c.startLine == null || c.endLine == null) continue;
    const f = rel(c.path); pf.add(f); const gl = goldLines.get(f);
    for (let i = c.startLine; i <= c.endLine; i++) { pl++; if (gl?.has(i)) { ph++; gh.add(`${f}:${i}`); } }
  }
  const fileCov = [...goldFiles].filter((f) => pf.has(f)).length / goldFiles.size;
  const filePrec = pf.size ? [...pf].filter((f) => goldFiles.has(f)).length / pf.size : 0;
  const lineCov = totalGoldLines ? gh.size / totalGoldLines : 0;
  const linePrec = pl ? ph / pl : 0;
  return { fileCov, filePrec, lineCov, linePrec, mean: (fileCov + filePrec + lineCov + linePrec) / 4 };
}

const fmt = (r: ReturnType<typeof score>) => `${(r.fileCov*100).toFixed(0).padStart(4)}%  ${(r.filePrec*100).toFixed(0).padStart(4)}%  ${(r.lineCov*100).toFixed(0).padStart(4)}%  ${(r.linePrec*100).toFixed(1).padStart(5)}%   mean ${(r.mean*100).toFixed(1)}`;

async function chunkFromFile(db: RagDB, cfg: any, fileRel: string): Promise<ChunkResult | null> {
  // best leaf chunk of one file for the issue query (scope via dir-prefix filter)
  const res = await searchChunks(issue, db, 1, 0.0, cfg.hybridWeight, cfg.generated, { dirs: [repoDir + "/" + fileRel] }, cfg.parentGroupingMinCount, true);
  return res[0] ?? null;
}

async function expand(db: RagDB, cfg: any, base: ChunkResult[], topFiles: number, perImport: number, gate: number): Promise<ChunkResult[]> {
  const have = new Set(base.map((c) => rel(c.path)));
  // top files by best chunk score
  const fileBest = new Map<string, number>();
  for (const c of base) { const f = rel(c.path); if (!fileBest.has(f)) fileBest.set(f, c.score); }
  const seedFiles = [...fileBest.entries()].sort((a, b) => b[1] - a[1]).slice(0, topFiles).map((e) => e[0]);
  const added: ChunkResult[] = [];
  const importSeen = new Set<string>();
  for (const sf of seedFiles) {
    const file = db.getFileByPath(repoDir + "/" + sf); if (!file) continue;
    const imports = db.getDependsOn(file.id).map((d) => rel(d.path));
    for (const imp of imports) {
      if (have.has(imp) || importSeen.has(imp)) continue;
      importSeen.add(imp);
      const c = await chunkFromFile(db, cfg, imp);
      if (c && c.score >= gate) { added.push(c); have.add(imp); }
    }
  }
  // keep only the top perImport*seedFiles additions by score (bound precision cost)
  added.sort((a, b) => b.score - a.score);
  return [...base, ...added.slice(0, perImport)];
}

async function main() {
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  console.log(`gold ${gold.length} spans / ${goldFiles.size} files\n            fileCov filePrec lineCov linePrec`);
  for (const K of [12, 20]) {
    const base = await searchChunks(issue, db, K, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true);
    console.log(`\n── base top${K} ──`);
    console.log(`baseline    ${fmt(score(base))}`);
    for (const gate of [0.3, 0.4, 0.5]) {
      for (const maxAdd of [3, 6]) {
        const ex = await expand(db, cfg, base, 8, maxAdd, gate);
        console.log(`+graph g${gate} +${maxAdd}  ${fmt(score(ex))}  (added ${ex.length - base.length})`);
      }
    }
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
