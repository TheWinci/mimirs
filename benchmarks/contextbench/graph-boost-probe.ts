/**
 * Bucket-2 hypothesis: secondary gold files (helpers edited by the fix but not
 * named in the issue) are often in the 1-hop import/call graph of the TOP-1 hit.
 * If so, a "expand from the confident anchor" boost could recover them.
 * For each struggler: distilled search -> top1 -> its depends_on (callees/imports)
 * + dependedOnBy (callers), then check where each MISSING gold sits.
 *   bun benchmarks/contextbench/graph-boost-probe.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search } from "../../src/search/hybrid";

const tasks: any = {};
for (const l of readFileSync("/tmp/cb-tasks-big.jsonl", "utf8").split("\n").filter((x) => x.trim())) {
  const t = JSON.parse(l); tasks[t.instance_id] = t;
}
const gold = JSON.parse(readFileSync("/tmp/cb-all-gold.json", "utf8"));
const distilled = JSON.parse(readFileSync("/tmp/cb-distilled.json", "utf8"));
const STRUGGLERS = ["deb49033", "bebfd692", "da598baa"]; // multi-file, buried secondary gold

async function main() {
  for (const [iid, t] of Object.entries<any>(tasks)) {
    const sid = iid.split("__").pop()!.slice(0, 8);
    if (!STRUGGLERS.includes(sid)) continue;
    const name = `${t.repo.split("/")[1]}-${sid}`;
    const dir = `/Users/winci/repos/cb-repos/${name}`;
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    try {
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      const gfiles: string[] = [...new Set(gold[iid].gold.map((g: any) => g.file))] as string[];
      const res = await search(distilled[iid], db, 60, 0, config.hybridWeight, []);
      const ranked = res.map((r) => rel(r.path));
      const top8 = new Set(ranked.slice(0, 8));
      const top1 = ranked[0];

      // 1-hop graph neighborhood of top1
      const f1 = db.getFileByPath(resolve(dir, top1));
      const deps = f1 ? db.getDependsOn(f1.id).map((d: any) => rel(d.path)) : [];
      const callers = f1 ? db.getDependedOnBy(f1.id).map((d: any) => rel(d.path)) : [];
      const neigh = new Set([...deps, ...callers]);

      console.log(`\n=== ${sid} (${t.repo.split("/")[1]}) — top1: ${top1}`);
      console.log(`    top1 imports ${deps.length}, imported-by ${callers.length}`);
      for (const g of gfiles) {
        const r = ranked.indexOf(g);
        const inTop8 = top8.has(g);
        const inGraph = neigh.has(g);
        const where = r >= 0 ? `rank ${r + 1}` : ">60";
        const recover = !inTop8 && inGraph ? "  <-- GRAPH-RECOVERABLE from top1" : "";
        console.log(`    ${inTop8 ? "✓top8" : "      "} gold ${g}  (${where})${inGraph ? " [in top1 graph]" : ""}${recover}`);
      }
    } finally { db.close(); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
