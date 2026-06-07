/**
 * ContextBench-style scoring on the already-indexed arena instance (deb49033),
 * leaf vs default — no re-clone. Query = issue text; pred = searchChunks spans;
 * score line coverage + precision vs gold. Proves the leaf precision lever on a
 * real instance cheaply. Run: bun benchmarks/contextbench/arena-score.ts
 */
import { readFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks } from "../../src/search/hybrid";

const repoDir = "/tmp/cb-arena/repo";
const issue = readFileSync("/tmp/cb-arena/issue.txt", "utf8");
const gold = (JSON.parse(readFileSync("/tmp/cb-arena-gold.json", "utf8")).gold) as { file: string; start: number; end: number }[];

const goldFiles = new Set(gold.map((g) => g.file));
// gold line set per file
const goldLines = new Map<string, Set<number>>();
for (const g of gold) {
  const s = goldLines.get(g.file) ?? new Set<number>();
  for (let i = g.start; i <= g.end; i++) s.add(i);
  goldLines.set(g.file, s);
}
const totalGoldLines = [...goldLines.values()].reduce((a, s) => a + s.size, 0);

async function score(db: RagDB, cfg: any, leafOnly: boolean, top: number) {
  const chunks = await searchChunks(issue, db, top, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, leafOnly);
  const predFiles = new Set<string>();
  let predLineTotal = 0, predLineHit = 0;
  const goldLineHit = new Set<string>();
  let contentChars = 0;
  for (const c of chunks) {
    contentChars += c.content.length;
    if (c.startLine == null || c.endLine == null) continue;
    const rel = c.path.startsWith(repoDir) ? c.path.slice(repoDir.length + 1) : c.path;
    predFiles.add(rel);
    const gl = goldLines.get(rel);
    for (let i = c.startLine; i <= c.endLine; i++) {
      predLineTotal++;
      if (gl && gl.has(i)) { predLineHit++; goldLineHit.add(`${rel}:${i}`); }
    }
  }
  const fileCov = [...goldFiles].filter((f) => predFiles.has(f)).length / goldFiles.size;
  const fileInter = [...predFiles].filter((f) => goldFiles.has(f)).length;
  const filePrec = predFiles.size ? fileInter / predFiles.size : 0;
  const lineCov = totalGoldLines ? goldLineHit.size / totalGoldLines : 0;
  const linePrec = predLineTotal ? predLineHit / predLineTotal : 0;
  return { chunks: chunks.length, contentChars, fileCov, filePrec, lineCov, linePrec, predLineTotal };
}

async function main() {
  const db = new RagDB(repoDir);
  const cfg = await loadConfig(repoDir);
  console.log(`deb49033 (astropy-13398) — gold ${gold.length} spans / ${totalGoldLines} lines, ${goldFiles.size} files\n`);
  console.log(`mode        chars  chunks predLines  fileCov filePrec  lineCov linePrec`);
  const sweep: [string, boolean, number][] = [
    ["default", false, 20], ["leaf", true, 20], ["leaf", true, 12],
    ["leaf", true, 8], ["leaf", true, 5], ["leaf", true, 3], ["leaf", true, 2],
  ];
  for (const [label, leaf, top] of sweep) {
    const r = await score(db, cfg, leaf, top);
    console.log(`${label.padEnd(8)} t${String(top).padStart(2)}  ${String(r.contentChars).padStart(6)}  ${String(r.chunks).padStart(5)}  ${String(r.predLineTotal).padStart(7)}    ${(r.fileCov*100).toFixed(0).padStart(3)}%    ${(r.filePrec*100).toFixed(0).padStart(3)}%    ${(r.lineCov*100).toFixed(0).padStart(3)}%    ${(r.linePrec*100).toFixed(1).padStart(4)}%`);
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
