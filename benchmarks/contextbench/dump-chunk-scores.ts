/**
 * Dump the top-10 leaf-chunk scores per instance for the distilled query — score,
 * Δ%, rel.85 keep flag (score >= top*0.85), and gold-line overlap — to markdown.
 * For reasoning about how to boost chunk scores.
 *   bun benchmarks/contextbench/dump-chunk-scores.ts <out.md>
 */
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks } from "../../src/search/hybrid";

const tasks = readFileSync("/tmp/cb-tasks-big.jsonl", "utf8").split("\n").filter((x) => x.trim()).map((l) => JSON.parse(l));
const gold = JSON.parse(readFileSync("/tmp/cb-all-gold.json", "utf8"));
const distilled = JSON.parse(readFileSync("/tmp/cb-distilled.json", "utf8"));
const REL = 0.85;

async function main() {
  const out = process.argv[2] ?? "/tmp/chunk-scores.md";
  writeFileSync(out, `# Top-10 leaf-chunk scores — distilled query, rel .85 cut\n\nPer instance: rank, final score, Δ% from prev, KEEP=kept by rel.85 (score ≥ top×0.85), gold=lines overlapping gold span. Pipeline: RRF(vector,BM25) × path/affinity mult + graphBoost.\n`);

  for (const t of tasks) {
    const sid = t.instance_id.split("__").pop()!.slice(0, 8);
    const name = `${t.repo.split("/")[1]}-${sid}`;
    const dir = `/Users/winci/repos/cb-repos/${name}`;
    const db = new RagDB(dir);
    const cfg = await loadConfig(dir);
    try {
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      const goldLines = new Map<string, Set<number>>();
      for (const g of gold[t.instance_id].gold) {
        const s = goldLines.get(g.file) ?? new Set<number>();
        for (let i = g.start; i <= g.end; i++) s.add(i);
        goldLines.set(g.file, s);
      }
      const ov = (p: string, a: number, b: number) => {
        const gl = goldLines.get(rel(p)); if (!gl) return 0;
        let n = 0; for (let i = a; i <= b; i++) if (gl.has(i)) n++; return n;
      };
      const chunks = await searchChunks(distilled[t.instance_id], db, 10, 0.3, cfg.hybridWeight, [], undefined, cfg.parentGroupingMinCount, true);
      const cut = chunks.length ? chunks[0].score * REL : 0;
      let md = `\n## ${name} (gold ${goldLines.size} files)\nquery: \`${distilled[t.instance_id]}\`\n\n`;
      md += `| rank | score | Δ% | keep | gold | file:lines |\n|---|---|---|---|---|---|\n`;
      chunks.forEach((c, i) => {
        const g = c.startLine != null && c.endLine != null ? ov(c.path, c.startLine, c.endLine) : 0;
        const dp = i > 0 && chunks[i - 1].score > 0 ? (chunks[i - 1].score - c.score) / chunks[i - 1].score * 100 : 0;
        md += `| ${i + 1} | ${c.score.toFixed(4)} | ${dp.toFixed(0)}% | ${c.score >= cut ? "Y" : "·"} | ${g > 0 ? "**" + g + "**" : ""} | ${rel(c.path)}:${c.startLine}-${c.endLine} |\n`;
      });
      appendFileSync(out, md);
      process.stdout.write(`${name} `);
    } finally { db.close(); }
  }
  console.log(`\nwrote ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
