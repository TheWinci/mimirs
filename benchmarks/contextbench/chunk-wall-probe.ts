/**
 * Chunk-score curve for distilled queries: rank, score, Δ%, and whether the leaf
 * chunk overlaps gold lines. To design a wall cutoff on CHUNKS (for line precision)
 * — does a structural drop separate gold chunks from the noise tail?
 *   bun benchmarks/contextbench/chunk-wall-probe.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks } from "../../src/search/hybrid";

const tasks: any = {};
for (const l of readFileSync("/tmp/cb-tasks-big.jsonl", "utf8").split("\n").filter((x) => x.trim())) {
  const t = JSON.parse(l); tasks[t.instance_id] = t;
}
const gold = JSON.parse(readFileSync("/tmp/cb-all-gold.json", "utf8"));
const distilled = JSON.parse(readFileSync("/tmp/cb-distilled.json", "utf8"));
const PICK: Record<string, string> = {
  deb49033: "astropy-deb49033", "88e1ffd3": "requests-88e1ffd3", bebfd692: "matplotlib-bebfd692",
};

async function main() {
  for (const [iid, t] of Object.entries<any>(tasks)) {
    const sid = iid.split("__").pop()!.slice(0, 8);
    if (!PICK[sid]) continue;
    const dir = `/Users/winci/repos/cb-repos/${PICK[sid]}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    try {
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      // gold lines per file
      const goldLines = new Map<string, Set<number>>();
      for (const g of gold[iid].gold) {
        const s = goldLines.get(g.file) ?? new Set<number>();
        for (let i = g.start; i <= g.end; i++) s.add(i);
        goldLines.set(g.file, s);
      }
      const overlaps = (path: string, a: number, b: number) => {
        const gl = goldLines.get(rel(path)); if (!gl) return 0;
        let n = 0; for (let i = a; i <= b; i++) if (gl.has(i)) n++; return n;
      };
      const chunks = await searchChunks(distilled[iid], db, 30, 0.3, cfg.hybridWeight, [], undefined, cfg.parentGroupingMinCount, true);
      console.log(`\n=== ${sid} (${t.repo.split("/")[1]}) — ${chunks.length} leaf chunks`);
      console.log(`rank  score    Δ%    gold  file:lines`);
      chunks.forEach((c, i) => {
        const g = c.startLine != null && c.endLine != null ? overlaps(c.path, c.startLine, c.endLine) : 0;
        const dp = i > 0 && chunks[i - 1].score > 0 ? (chunks[i - 1].score - c.score) / chunks[i - 1].score * 100 : 0;
        console.log(`${String(i + 1).padStart(3)}  ${c.score.toFixed(4)}  ${dp.toFixed(0).padStart(3)}%  ${g > 0 ? "G(" + g + ")" : "  - "}  ${rel(c.path)}:${c.startLine}-${c.endLine}`);
      });
    } finally { db.close(); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
