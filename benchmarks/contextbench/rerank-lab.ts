/**
 * Rerank lab: pull a big leaf candidate pool for the issue query, apply candidate
 * rerank strategies, and score ALL ContextBench metrics (file/line cov + prec) on
 * the indexed arena instance — no agents, no re-clone. Fast loop to find a ranking
 * that raises gold-chunk rank so coverage AND precision win at small topK.
 *
 * Run: bun benchmarks/contextbench/rerank-lab.ts
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

function scorePred(chunks: ChunkResult[]) {
  const predFiles = new Set<string>(); let predLines = 0, predHit = 0; const goldHit = new Set<string>();
  for (const c of chunks) {
    if (c.startLine == null || c.endLine == null) continue;
    const f = rel(c.path); predFiles.add(f); const gl = goldLines.get(f);
    for (let i = c.startLine; i <= c.endLine; i++) { predLines++; if (gl?.has(i)) { predHit++; goldHit.add(`${f}:${i}`); } }
  }
  const fileCov = [...goldFiles].filter((f) => predFiles.has(f)).length / goldFiles.size;
  const filePrec = predFiles.size ? [...predFiles].filter((f) => goldFiles.has(f)).length / predFiles.size : 0;
  const lineCov = totalGoldLines ? goldHit.size / totalGoldLines : 0;
  const linePrec = predLines ? predHit / predLines : 0;
  // single balanced figure: mean of the 4 (so we can spot a dominating strategy)
  const mean = (fileCov + filePrec + lineCov + linePrec) / 4;
  return { fileCov, filePrec, lineCov, linePrec, mean };
}

// ── rerank strategies over a candidate pool ──
const byScore = (pool: ChunkResult[]) => [...pool].sort((a, b) => b.score - a.score);

// MMR with file-diversity penalty: discourage piling many chunks from one file.
function mmrFile(pool: ChunkResult[], lambda: number): ChunkResult[] {
  const ranked = byScore(pool); const out: ChunkResult[] = []; const fileCount = new Map<string, number>();
  const remaining = new Set(ranked);
  while (remaining.size) {
    let best: ChunkResult | null = null, bestV = -Infinity;
    for (const c of remaining) {
      const fc = fileCount.get(rel(c.path)) ?? 0;
      const v = c.score - lambda * fc; // each prior same-file pick costs lambda
      if (v > bestV) { bestV = v; best = c; }
    }
    if (!best) break;
    out.push(best); remaining.delete(best);
    fileCount.set(rel(best.path), (fileCount.get(rel(best.path)) ?? 0) + 1);
  }
  return out;
}

// Entity/identifier boost: chunks whose entity name or file stem appears in the issue.
function entityBoost(pool: ChunkResult[], boost: number): ChunkResult[] {
  const text = issue.toLowerCase();
  return [...pool].map((c) => {
    const name = (c.entityName ?? "").toLowerCase();
    const stem = rel(c.path).split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
    let s = c.score;
    if (name && name.length >= 3 && text.includes(name)) s += boost;
    if (stem.length >= 3 && text.includes(stem)) s += boost * 0.5;
    return { ...c, score: s };
  }).sort((a, b) => b.score - a.score);
}

async function main() {
  const db = new RagDB(repoDir); const cfg = await loadConfig(repoDir);
  const pool = await searchChunks(issue, db, 40, 0.0, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, true);
  console.log(`Pool: ${pool.length} leaf candidates. gold ${gold.length} spans / ${goldFiles.size} files\n`);
  const strategies: [string, (p: ChunkResult[]) => ChunkResult[]][] = [
    ["baseline", byScore],
    ["mmrFile l.05", (p) => mmrFile(p, 0.05)],
    ["mmrFile l.10", (p) => mmrFile(p, 0.10)],
    ["mmrFile l.20", (p) => mmrFile(p, 0.20)],
    ["entity .15", (p) => entityBoost(p, 0.15)],
    ["entity+mmr", (p) => mmrFile(entityBoost(p, 0.15), 0.10)],
  ];
  for (const K of [8, 12, 20]) {
    console.log(`── top ${K} ──   strategy        fileCov filePrec lineCov linePrec  mean`);
    for (const [name, fn] of strategies) {
      const r = scorePred(fn(pool).slice(0, K));
      console.log(`              ${name.padEnd(14)}  ${(r.fileCov*100).toFixed(0).padStart(4)}%   ${(r.filePrec*100).toFixed(0).padStart(4)}%  ${(r.lineCov*100).toFixed(0).padStart(4)}%   ${(r.linePrec*100).toFixed(1).padStart(5)}%  ${(r.mean*100).toFixed(1)}`);
    }
    console.log();
  }
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
