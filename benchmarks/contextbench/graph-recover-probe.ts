/**
 * Would mimirs graph tools (depends_on/dependents/impact) recover the SECONDARY
 * gold that retrieval+grep miss? For each instance: anchor on each gold file,
 * expand the file dependency graph 1-hop and 2-hop (imports + importers), and
 * measure how many OTHER gold files are reachable. Best-anchor coverage = the
 * ceiling a graph-expansion agent could hit starting from one found file.
 *   bun benchmarks/contextbench/graph-recover-probe.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";

const tasks: any = {};
for (const l of readFileSync("/tmp/cb-tasks-big.jsonl", "utf8").split("\n").filter((x) => x.trim())) {
  const t = JSON.parse(l); tasks[t.instance_id] = t;
}
const gold = JSON.parse(readFileSync("/tmp/cb-all-gold.json", "utf8"));
const PICK: Record<string, string> = {
  deb49033: "astropy-deb49033", bebfd692: "matplotlib-bebfd692", da598baa: "pylint-da598baa",
};

function neighbors(db: RagDB, path: string): string[] {
  const f = db.getFileByPath(path);
  if (!f) return [];
  const out = [...db.getDependsOn(f.id), ...db.getDependedOnBy(f.id)].map((d: any) => d.path);
  return [...new Set(out)];
}

async function main() {
  for (const [iid, t] of Object.entries<any>(tasks)) {
    const sid = iid.split("__").pop()!.slice(0, 8);
    if (!PICK[sid]) continue;
    const dir = `/Users/winci/repos/cb-repos/${PICK[sid]}`;
    const db = new RagDB(dir);
    try {
      const abs = (f: string) => resolve(dir, f);
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      const goldFiles: string[] = [...new Set(gold[iid].gold.map((g: any) => g.file))] as string[];

      console.log(`\n=== ${sid} (${t.repo.split("/")[1]}) — ${goldFiles.length} gold`);
      // how connected is the gold set at all? edges among gold files:
      let bestAnchor = "", best1 = 0, best2 = 0;
      for (const anchor of goldFiles) {
        const others = new Set(goldFiles.filter((g) => g !== anchor));
        const hop1 = new Set(neighbors(db, abs(anchor)).map(rel));
        const hop2 = new Set(hop1);
        for (const n of hop1) for (const nn of neighbors(db, abs(n)).map(rel)) hop2.add(nn);
        const c1 = [...others].filter((g) => hop1.has(g)).length;
        const c2 = [...others].filter((g) => hop2.has(g)).length;
        if (c2 > best2 || (c2 === best2 && c1 > best1)) { best2 = c2; best1 = c1; bestAnchor = anchor; }
      }
      // also: total non-empty graph nodes among gold (is the graph even populated?)
      const populated = goldFiles.filter((g) => neighbors(db, abs(g)).length > 0).length;
      console.log(`  gold files with ANY graph edges: ${populated}/${goldFiles.length}`);
      console.log(`  best anchor: ${bestAnchor}`);
      console.log(`  from best anchor: 1-hop reaches ${best1}/${goldFiles.length - 1} other gold, 2-hop reaches ${best2}/${goldFiles.length - 1}`);
      console.log(`  => max gold an agent could collect via graph from one found file: ${best2 + 1}/${goldFiles.length}`);
    } finally { db.close(); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
