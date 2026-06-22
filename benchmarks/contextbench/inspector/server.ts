/**
 * Retrieval inspector server (plans/retrieval-inspector.md).
 * Bun.serve, no framework. Runs the PRODUCTION traced search()/searchChunks()
 * on a cached ContextBench instance and returns the per-stage trace + a
 * gold-neighbourhood graph. Holds RagDB open per instance (lazy + cached); the
 * embed model loads once on first query and stays warm.
 *
 * Run: bun benchmarks/contextbench/inspector/server.ts   →  http://localhost:7333
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { RagDB } from "../../../src/db";
import { loadConfig, type RagConfig } from "../../../src/config";
import { search, searchChunks, type SearchTrace } from "../../../src/search/hybrid";

const CB = "/Users/winci/repos/cb-repos";
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7333;

interface Inst { instance_id: string; dir: string; repo: string; problem_statement: string; gold: { file: string; start: number; end: number }[] }
const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
dataset.sort((a, b) => a.dir.localeCompare(b.dir));
const byDir = new Map(dataset.map((d) => [d.dir, d]));

// ── lazy DB + config cache ──
const cache = new Map<string, { db: RagDB; cfg: RagConfig }>();
async function open(instance: string) {
  let c = cache.get(instance);
  if (!c) {
    const dir = `${CB}/${instance}`;
    c = { db: new RagDB(dir), cfg: await loadConfig(dir) };
    cache.set(instance, c);
  }
  return c;
}

// ── trace collector ──
function collect(): SearchTrace & { stages: { name: string; payload: unknown }[] } {
  const stages: { name: string; payload: unknown }[] = [];
  return { stage: (name, payload) => stages.push({ name, payload }), stages };
}

// ── leak-safe co-change graph (mirrors cb-reach.ts) ──
function buildCoGraph(gitDir: string, maxCommitFiles = 25) {
  const out = execFileSync("git", ["-C", gitDir, "log", "HEAD", "--no-merges", "--name-only", "--pretty=format:@@@%H"], { maxBuffer: 1 << 30 }).toString();
  const commits: string[][] = []; let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@@")) { if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur); cur = []; }
    else if (line.trim()) cur?.push(line.trim());
  }
  if (cur && cur.length >= 2 && cur.length <= maxCommitFiles) commits.push(cur);
  const count = new Map<string, number>(); const idx = new Map<string, number[]>();
  commits.forEach((files, i) => { for (const f of new Set(files)) { count.set(f, (count.get(f) ?? 0) + 1); (idx.get(f) ?? idx.set(f, []).get(f)!).push(i); } });
  const jaccard = (a: string, b: string): number => {
    const ia = idx.get(a); if (!ia) return 0; const setB = new Set(idx.get(b) ?? []);
    let t = 0; for (const i of ia) if (setB.has(i)) t++; if (!t) return 0;
    return t / ((count.get(a) ?? 0) + (count.get(b) ?? 0) - t);
  };
  return { jaccard };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const numParam = (u: URL, k: string, d: number) => { const v = u.searchParams.get(k); return v == null || v === "" ? d : Number(v); };
const boolParam = (u: URL, k: string) => u.searchParams.get(k) === "true";

async function trace(u: URL) {
  const instance = u.searchParams.get("instance")!;
  const g = byDir.get(instance);
  if (!g) return json({ error: `unknown instance ${instance}` }, 404);
  const { db, cfg } = await open(instance);
  const mode = u.searchParams.get("mode") === "raw" ? "raw" : "distilled";
  const query = mode === "raw" ? g.problem_statement : (queries[instance] ?? g.problem_statement);

  const weight = numParam(u, "weight", cfg.hybridWeight);
  const k = numParam(u, "k", 60);
  const kchunk = numParam(u, "kchunk", 10);
  const threshold = numParam(u, "threshold", 0.3);
  const leafOnly = u.searchParams.get("leafOnly") == null ? cfg.leafOnly : boolParam(u, "leafOnly");
  const pgmc = numParam(u, "pgmc", cfg.parentGroupingMinCount);
  const relCutoff = numParam(u, "relCutoff", cfg.chunkRelCutoff);
  const steepSkip = numParam(u, "steepSkip", cfg.chunkSteepSkip);
  const parentBoost = numParam(u, "parentBoost", cfg.chunkParentBoost);

  const fileC = collect(), chunkC = collect();
  const t0 = performance.now();
  await search(query, db, k, 0, weight, cfg.generated, undefined, fileC);
  const tFile = performance.now() - t0;
  const t1 = performance.now();
  await searchChunks(query, db, kchunk, threshold, weight, cfg.generated, undefined, pgmc, leafOnly, false, parentBoost, relCutoff, steepSkip, chunkC);
  const tChunk = performance.now() - t1;

  return json({
    instance, repo: g.repo, mode, query, dir: `${CB}/${instance}`,
    gold: g.gold, goldFiles: [...new Set(g.gold.map((x) => x.file))],
    params: { weight, k, kchunk, threshold, leafOnly, pgmc, relCutoff, steepSkip, parentBoost },
    file: fileC.stages, chunk: chunkC.stages,
    durations: { file: Math.round(tFile), chunk: Math.round(tChunk) },
  });
}

async function graph(u: URL) {
  const instance = u.searchParams.get("instance")!;
  const g = byDir.get(instance);
  if (!g) return json({ error: `unknown instance ${instance}` }, 404);
  const { db, cfg } = await open(instance);
  const dir = `${CB}/${instance}`;
  const rel = (p: string) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);
  const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);
  const k = numParam(u, "k", 12);
  const includeFix = boolParam(u, "includeFix");
  const coFloor = numParam(u, "coFloor", 0.05);

  const goldFiles = [...new Set(g.gold.map((x) => x.file))];
  const query = queries[instance] ?? g.problem_statement;
  const ranked = (await search(query, db, k, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));

  // undirected import adjacency in rel space
  const gr = db.getGraph();
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of gr.edges as { fromPath: string; toPath: string }[]) {
    const a = rel(e.fromPath), b = rel(e.toPath); if (a !== b) { add(a, b); add(b, a); }
  }
  const allNodes = gr.nodes.map((n: { path: string }) => rel(n.path));
  const goldNodes = allNodes.filter((p) => goldFiles.some((gf) => hit(p, gf)));

  // node set: gold ∪ retrieved top-k ∪ 1-hop import neighbours of gold
  const nodeSet = new Set<string>([...goldNodes, ...ranked.slice(0, k)]);
  for (const gn of goldNodes) for (const nb of adj.get(gn) ?? []) nodeSet.add(nb);

  const scratch = `/tmp/cc-${instance}`;
  const coDir = includeFix ? dir : (existsSync(`${scratch}/.git`) ? scratch : dir);
  let co: ReturnType<typeof buildCoGraph> | null = null;
  try { co = buildCoGraph(coDir); } catch { co = null; }

  const rankOf = (p: string) => { const i = ranked.indexOf(p); return i < 0 ? null : i + 1; };
  const isGold = (p: string) => goldFiles.some((gf) => hit(p, gf));
  const nodes = [...nodeSet].map((p) => ({
    id: p, label: p.split("/").pop(),
    kind: isGold(p) ? "gold" : (rankOf(p) != null ? "retrieved" : "neighbour"),
    rank: rankOf(p),
  }));

  const inSet = (p: string) => nodeSet.has(p);
  const edges: { source: string; target: string; type: string; goldGold: boolean }[] = [];
  const seen = new Set<string>();
  // import edges among included nodes
  for (const [a, nbs] of adj) {
    if (!inSet(a)) continue;
    for (const b of nbs) {
      if (!inSet(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has("i:" + key)) continue; seen.add("i:" + key);
      edges.push({ source: a, target: b, type: "import", goldGold: isGold(a) && isGold(b) });
    }
  }
  // co-change edges among included nodes
  if (co) {
    const arr = [...nodeSet];
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const jac = co.jaccard(arr[i], arr[j]);
      if (jac >= coFloor) edges.push({ source: arr[i], target: arr[j], type: "cochange", goldGold: isGold(arr[i]) && isGold(arr[j]) });
    }
  }

  return json({ instance, nodes, edges, coSource: co ? (coDir === dir ? "canonical (LEAKS fix)" : "leak-safe /tmp") : "none" });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/") return new Response(Bun.file(`${HERE}/index.html`));
      if (u.pathname === "/app.js") return new Response(Bun.file(`${HERE}/app.js`));
      if (u.pathname === "/api/instances")
        return json(dataset.map((d) => ({
          dir: d.dir, repo: d.repo,
          goldFiles: new Set(d.gold.map((x) => x.file)).size,
          goldLines: d.gold.reduce((a, x) => a + (x.end - x.start + 1), 0),
        })));
      if (u.pathname === "/api/trace") return await trace(u);
      if (u.pathname === "/api/graph") return await graph(u);
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
});
console.log(`retrieval inspector → http://localhost:${PORT}  (${dataset.length} instances)`);
