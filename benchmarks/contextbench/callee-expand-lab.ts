/**
 * Callee-expansion lab: gold context often includes helper symbols the fix USES
 * but that don't match the issue text (low semantic score) — e.g. rotation_matrix,
 * PIOVER2. Pure retrieval misses them; relevance-gated import expansion also misses
 * them (low score). But mimirs' symbol graph knows exactly which symbols the
 * retrieved code references. So: from the top retrieved chunks, resolve their
 * referenced symbols to callee spans (file+lines) and add the most-referenced ones.
 * Scores all ContextBench metrics on the arena. Run: bun .../callee-expand-lab.ts
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
const rel = (p: string) => !p ? "" : (p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p);

type Span = { path: string; startLine: number | null; endLine: number | null };
function score(chunks: Span[]) {
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
const fmt = (r: ReturnType<typeof score>) => `${(r.fileCov*100).toFixed(0).padStart(4)}%  ${(r.filePrec*100).toFixed(0).padStart(4)}%  ${(r.lineCov*100).toFixed(0).padStart(4)}%  ${(r.linePrec*100).toFixed(1).padStart(5)}%  mean ${(r.mean*100).toFixed(1)}`;

async function main() {
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  // exportId -> callee span
  const exMap = new Map<number, Span & { name: string }>();
  for (const ex of db.getCallableExports()) exMap.set(ex.exportId, { path: ex.path, startLine: ex.startLine, endLine: ex.endLine, name: ex.name });

  console.log(`gold ${gold.length} spans / ${goldFiles.size} files\n           fileCov filePrec lineCov linePrec`);
  for (const K of [12, 20]) {
    const base = await searchChunks(issue, db, K, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true);
    const baseSpans: Span[] = base.map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine }));

    // collect callees referenced by base chunks, counted by frequency
    const calleeCount = new Map<number, number>();
    for (const c of base) {
      if (c.startLine == null || c.endLine == null) continue;
      const file = db.getFileByPath(c.path); if (!file) continue;
      for (const ref of db.getSymbolRefsInRange(file.id, c.startLine, c.endLine)) {
        if (ref.resolvedExportId != null && exMap.has(ref.resolvedExportId)) {
          calleeCount.set(ref.resolvedExportId, (calleeCount.get(ref.resolvedExportId) ?? 0) + 1);
        }
      }
    }
    const baseFiles = new Set(baseSpans.map((s) => rel(s.path)));
    // rank callees: prefer those in files not already covered (new coverage), then frequency
    const ranked = [...calleeCount.entries()]
      .map(([id, n]) => ({ id, n, sp: exMap.get(id)! }))
      .filter((e) => e.sp.startLine != null && !!e.sp.path)
      .sort((a, b) => (Number(baseFiles.has(rel(b.sp.path))) - Number(baseFiles.has(rel(a.sp.path)))) || (b.n - a.n));

    console.log(`\n── base top${K} ──`);
    console.log(`baseline   ${fmt(score(baseSpans))}`);
    for (const M of [3, 6, 10, 16]) {
      const add = ranked.slice(0, M).map((e) => ({ path: e.sp.path, startLine: e.sp.startLine, endLine: e.sp.endLine }));
      console.log(`+callee ${String(M).padStart(2)} ${fmt(score([...baseSpans, ...add]))}  (uniq callees avail=${ranked.length})`);
    }
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
