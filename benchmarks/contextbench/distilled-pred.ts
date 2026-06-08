/**
 * Produce ContextBench pred files using LLM-DISTILLED queries against the
 * already-indexed cb-repos (no re-clone). Tests the hypothesis: mimirs is a
 * retrieval primitive; given a focused query (what an LLM sends) instead of the
 * raw issue, gold ranks far higher. Emits fixed8/fixed12/wall variants.
 *   bun benchmarks/contextbench/distilled-pred.ts <tasks.jsonl> <distilled.json> <reposBase> <out.jsonl>
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";

const isBarrel = (p: string) => ["__init__.py", "index.ts", "index.js", "mod.rs"].includes((p.split("/").pop() ?? ""));

async function main() {
  const tasksPath = process.argv[2], distilledPath = process.argv[3], reposBase = process.argv[4], outPath = process.argv[5];
  const tasks = readFileSync(tasksPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const distilled = JSON.parse(readFileSync(distilledPath, "utf8")) as Record<string, string>;
  const vnames = ["fixed8", "fixed12", "wall", "prune"] as const;
  const vpath = (v: string) => outPath.replace(/\.jsonl$/, `.${v}.jsonl`);
  for (const v of vnames) writeFileSync(vpath(v), "");

  for (const t of tasks) {
    const q = distilled[t.instance_id];
    const name = `${t.repo.split("/")[1]}-${t.instance_id.split("__").pop()!.slice(0, 8)}`;
    const dir = resolve(reposBase, name);
    if (!q || !existsSync(resolve(dir, ".mimirs/index.db"))) { console.log(`  ${name} SKIP (no query/index)`); continue; }
    const db = new RagDB(dir);
    const config = await loadConfig(dir);
    try {
      const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
      // HWEIGHT overrides hybridWeight (vector↔BM25 fuse balance): higher = more
      // vector/semantic, lower = more BM25/keyword.
      const hw = parseFloat(process.env.HWEIGHT ?? String(config.hybridWeight));
      let pool = await search(q, db, 60, 0, hw, []);
      // NEIGHBOR_BOOST: fix-site files often import / are-imported-by the primary
      // hit. Boost pool files in the 1-hop graph neighborhood of the top-N anchors,
      // pulling graph-connected gold up into the top-8 (coverage + precision).
      const nbBoost = parseFloat(process.env.NEIGHBOR_BOOST ?? "0");
      if (nbBoost > 0) {
        const anchorN = parseInt(process.env.NEIGHBOR_ANCHORS ?? "1", 10);
        const neigh = new Set<string>();
        for (const r of pool.slice(0, anchorN)) {
          const fobj = db.getFileByPath(r.path);
          if (!fobj) continue;
          for (const d of [...db.getDependsOn(fobj.id), ...db.getDependedOnBy(fobj.id)]) neigh.add(rel(d.path));
        }
        pool = pool
          .map((r) => (neigh.has(rel(r.path)) ? { ...r, score: r.score + nbBoost } : r))
          .sort((a, b) => b.score - a.score);
      }
      const nb = pool.filter((r) => !isBarrel(r.path));
      const s = nb.map((r) => r.score);
      let lastWall = 1;
      for (let i = 1; i < s.length; i++) {
        const raw = s[i - 1] - s[i], pct = s[i - 1] > 0 ? raw / s[i - 1] : 0;
        if (pct >= 0.15 && raw >= 1.0) lastWall = i;
      }
      const threshold = s.length ? s[Math.min(lastWall, s.length - 1)] : 0;
      // Spans via the PRODUCT read path: searchChunks with the committed config knobs
      // (chunkParentBoost + adaptive tail cut). Top-K 10 to match the measured peak.
      const pred_spans: Record<string, { start: number; end: number }[]> = {};
      const chunks = await searchChunks(q, db, 10, 0.3, config.hybridWeight, [], undefined,
        config.parentGroupingMinCount, config.leafOnly, false,
        config.chunkParentBoost, config.chunkRelCutoff, config.chunkSteepSkip);
      for (const c of chunks) {
        if (c.startLine == null || c.endLine == null) continue;
        (pred_spans[rel(c.path)] ??= []).push({ start: c.startLine, end: c.endLine });
      }
      const mk = (files: string[]) => ({ instance_id: t.instance_id, traj_data: { pred_files: files, pred_spans } });
      const f8 = pool.slice(0, 8).map((r) => rel(r.path));
      const f12 = pool.slice(0, 12).map((r) => rel(r.path));
      const b = pool.filter((r) => r.score >= threshold).map((r) => rel(r.path));
      // CHUNK-PRUNE: keep only top-N files that have a supporting chunk in the
      // searchChunks top-K (drop diffuse-keyword files with no precise match).
      const pruneK = parseInt(process.env.FILE_PRUNE_K ?? "0", 10);
      let pruned = f8;
      if (pruneK > 0) {
        const supp = await searchChunks(q, db, pruneK, 0.3, config.hybridWeight, [], undefined, config.parentGroupingMinCount, config.leafOnly);
        const suppSet = new Set(supp.map((c) => rel(c.path)));
        const cand = parseInt(process.env.FILE_PRUNE_CAND ?? "12", 10);
        pruned = pool.slice(0, cand).map((r) => rel(r.path)).filter((f) => suppSet.has(f)).slice(0, 8);
      }
      appendFileSync(vpath("fixed8"), JSON.stringify(mk(f8)) + "\n");
      appendFileSync(vpath("fixed12"), JSON.stringify(mk(f12)) + "\n");
      appendFileSync(vpath("wall"), JSON.stringify(mk(b)) + "\n");
      appendFileSync(vpath("prune"), JSON.stringify(mk(pruned)) + "\n");
      console.log(`  ${name}: f8=${f8.length} f12=${f12.length} B=${b.length} prune=${pruned.length}`);
    } finally { db.close(); }
  }
  console.log(`Done -> ${vnames.map(vpath).join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
